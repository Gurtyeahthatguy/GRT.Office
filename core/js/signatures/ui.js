/** Signatures as the programs show them: checked when a file opens, listed on request, trusted authorities chosen by the person. */

import { escapeHtml, showChoice } from '../panel.js';
import { parseCertificate, certificatesFromPem } from './crypto.js';
import { fromBase64 } from './asn1.js';
import { verifyOdfSignatures, verifyOoxmlSignatures } from './xml.js';

const MAX_TRUSTED = 200;
const MAX_CERTIFICATE = 64 * 1024;

/** The trusted authorities kept in the settings, as DER. */
export function trustedOf(settings) {
  const list = Array.isArray(settings?.trustedCertificates) ? settings.trustedCertificates : [];
  return list.slice(0, MAX_TRUSTED).map((b64) => { try { return fromBase64(String(b64)); } catch { return null; } })
    .filter((der) => der && der.length <= MAX_CERTIFICATE);
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(binary);
}

/**
 * Certificates from a file added to the trusted ones, each one read before it is kept.
 * @returns {{list: string[], added: string[]}} the new list, and the names of what was added
 */
export function addTrusted(list, bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)));
  const ders = text.includes('-----BEGIN CERTIFICATE-----') ? certificatesFromPem(text) : [bytes];
  const out = [...(Array.isArray(list) ? list : [])];
  const added = [];
  for (const der of ders) {
    if (der.length > MAX_CERTIFICATE || out.length >= MAX_TRUSTED) continue;
    let cert;
    try { cert = parseCertificate(der); } catch { continue; }
    const b64 = toBase64(der);
    if (out.includes(b64)) continue;
    out.push(b64);
    added.push(cert.subject.common || 'a certificate without a name');
  }
  return { list: out, added };
}

/** The names of the trusted authorities, for the list. */
const trustedNames = (settings) => trustedOf(settings).map((der) => { try { return parseCertificate(der).subject.common; } catch { return '?'; } });

/**
 * The signatures of an ODF or Office package, checked; empty when it has none.
 * @param {import('../package.js').Package} pkg
 */
export async function packageSignatures(pkg, trusted = []) {
  const read = (name) => pkg.bytes(name);
  try {
    if (pkg.has('META-INF/documentsignatures.xml')) return await verifyOdfSignatures(read, pkg.names, trusted);
    if (pkg.names.some((n) => /^_xmlsignatures\//i.test(n))) return await verifyOoxmlSignatures(read, pkg.names, trusted);
  } catch (error) {
    return [{ signer: null, intact: false, trusted: false, signingTime: null, problems: [String(error.message ?? error)] }];
  }
  return [];
}

/** One line on a signature: who, whether the file is as signed, whether the signer is vouched for. */
export function signatureLine(s) {
  const who = s.signer ? `Signed by ${s.signer}` : 'A signature';
  if (!s.intact) return `${who}: not valid, the file or the signature was changed after signing`;
  if (s.whole === false) return `${who}: valid for the part it signed, but the file was changed after it`;
  if (s.expired) return `${who}: the file is as signed, but the certificate was not valid when it was signed`;
  return `${who}: valid${s.trusted ? ', from a trusted authority' : ', but its authority is not among the trusted ones'}`;
}

/** What a losses list says about a signed file: GRT checks signatures and does not make them, so saving drops them. */
export function signatureLoss(results) {
  if (!results.length) return null;
  return `${results.map(signatureLine).join('; ')}. GRT checks digital signatures and does not make them: saving over the file removes them`;
}

const when = (date) => (date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'not given');

/** The list of signatures as HTML. */
export function signaturesHtml(results) {
  if (!results.length) return '<p>This file has no digital signatures.</p>';
  return `<ul class="problem-list">${results.map((s) => `<li><strong>${escapeHtml(signatureLine(s))}</strong>
    <br>Signed on: ${escapeHtml(when(s.signingTime))}${s.email ? `<br>Address: ${escapeHtml(s.email)}` : ''}
    ${s.chain?.length ? `<br>Certificates: ${escapeHtml(s.chain.join(' › '))}` : ''}
    ${s.problems?.length ? `<br>${s.problems.map((p) => escapeHtml(p)).join('<br>')}` : ''}</li>`).join('')}</ul>`;
}

/**
 * The Digital Signatures panel: the file's signatures, and the trusted authorities to add to or clear.
 * @param {{title: string, check: (trusted: Uint8Array[]) => Promise<Object[]>, settings: () => Object, saveSettings: () => Promise<void>, pickCertificate: () => Promise<?Uint8Array>, toast: (text: string) => void}} host
 */
export async function showSignatures(host) {
  for (;;) {
    const results = await host.check(trustedOf(host.settings()));
    const names = trustedNames(host.settings());
    const choice = await showChoice(host.title, `${signaturesHtml(results)}
      <p class="fp-note">A signature says who signed and that nothing changed since. Whether to believe the
      signer depends on the authority that issued the certificate: GRT trusts only the authorities you add here,
      nothing comes from the network.</p>
      <p class="fp-note">Whether a certificate was withdrawn after it was issued cannot be checked without the network,
      which GRT never opens: a withdrawn certificate still shows as valid here.</p>
      <p class="fp-note">Trusted authorities: ${names.length ? names.map(escapeHtml).join(', ') : 'none yet'}.</p>`, [
      { id: 'close', label: 'Close', primary: true },
      { id: 'add', label: 'Trust a certificate…' },
      ...(names.length ? [{ id: 'clear', label: 'Forget the trusted ones' }] : []),
    ]);
    if (choice === 'add') {
      const bytes = await host.pickCertificate();
      if (!bytes) continue;
      const { list, added } = addTrusted(host.settings().trustedCertificates, bytes);
      host.settings().trustedCertificates = list;
      await host.saveSettings();
      host.toast(added.length ? `Trusted: ${added.join(', ')}` : 'No new certificate in that file');
    } else if (choice === 'clear') {
      host.settings().trustedCertificates = [];
      await host.saveSettings();
    } else return;
  }
}

/**
 * Checks a package just opened: its signatures named among what saving would lose.
 * @returns {Promise<?import('../package.js').Package>} the package when it is signed, kept for the Digital Signatures panel
 */
export async function noteSignatures(pkg, losses, settings) {
  const results = await packageSignatures(pkg, trustedOf(settings));
  const line = signatureLoss(results);
  if (!line) return null;
  losses?.add(line);
  return pkg;
}
