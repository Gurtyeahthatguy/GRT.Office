/** Certificates and CMS signatures checked with the webview's own cryptography: who signed, whether the signature holds, and the chain behind it. */

import { parseDer, content, oid, text, time, sameBytes, toHex } from './asn1.js';

const subtle = globalThis.crypto?.subtle;
const HASHES = {
  '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const SIGNATURES = {
  '1.2.840.113549.1.1.5': ['RSA', 'SHA-1'], '1.2.840.113549.1.1.11': ['RSA', 'SHA-256'], '1.2.840.113549.1.1.12': ['RSA', 'SHA-384'],
  '1.2.840.113549.1.1.13': ['RSA', 'SHA-512'], '1.2.840.113549.1.1.1': ['RSA', null], '1.2.840.113549.1.1.10': ['PSS', null],
  '1.2.840.10045.4.1': ['EC', 'SHA-1'], '1.2.840.10045.4.3.2': ['EC', 'SHA-256'], '1.2.840.10045.4.3.3': ['EC', 'SHA-384'], '1.2.840.10045.4.3.4': ['EC', 'SHA-512'],
  '1.2.840.10045.2.1': ['EC', null],
};
const CURVES = { '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521' };
const NAMES = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '1.2.840.113549.1.9.1': 'E', '2.5.4.5': 'SERIALNUMBER' };

export const hashName = (algorithmOid) => HASHES[algorithmOid] ?? null;

export async function digest(hash, data) {
  return new Uint8Array(await subtle.digest(hash, data));
}

/** A distinguished name as text, and the parts people read. */
function nameOf(node) {
  const parts = [];
  for (const set of node.children ?? []) {
    for (const pair of set.children ?? []) {
      const key = oid(pair.children[0]);
      parts.push([NAMES[key] ?? key, text(pair.children[1])]);
    }
  }
  return { text: parts.map(([k, v]) => `${k}=${v}`).join(', '), common: parts.find(([k]) => k === 'CN')?.[1] ?? parts.find(([k]) => k === 'O')?.[1] ?? parts.map(([, v]) => v).join(' '), email: parts.find(([k]) => k === 'E')?.[1] ?? null };
}

/** A certificate's parts that matter here. */
export function parseCertificate(der) {
  const root = parseDer(der);
  const [tbs, algorithm, signature] = root.children;
  let i = 0;
  if (tbs.children[0].cls === 2) i += 1;
  const serial = toHex(content(tbs.children[i]));
  const issuer = tbs.children[i + 2];
  const validity = tbs.children[i + 3];
  const subject = tbs.children[i + 4];
  const spki = tbs.children[i + 5];
  const keyAlgorithm = spki.children[0];
  return {
    der, tbs: tbs.bytes, serial,
    signatureAlgorithm: oid(algorithm.children[0]), signatureParams: algorithm.children[1] ?? null,
    signature: content(signature).subarray(1),
    issuer: nameOf(issuer), issuerBytes: issuer.bytes, subject: nameOf(subject), subjectBytes: subject.bytes,
    notBefore: time(validity.children[0]), notAfter: time(validity.children[1]),
    spki: spki.bytes, keyAlgorithm: oid(keyAlgorithm.children[0]), curve: keyAlgorithm.children[1]?.tag === 6 ? CURVES[oid(keyAlgorithm.children[1])] ?? null : null,
  };
}

/** An ECDSA signature in DER as the r and s WebCrypto wants, each the curve's size. */
function rawEcdsa(der, curve) {
  const size = { 'P-256': 32, 'P-384': 48, 'P-521': 66 }[curve];
  const node = parseDer(der);
  const part = (n) => { let b = content(n); while (b.length > size && b[0] === 0) b = b.subarray(1); const out = new Uint8Array(size); out.set(b, size - b.length); return out; };
  const out = new Uint8Array(size * 2);
  out.set(part(node.children[0]), 0);
  out.set(part(node.children[1]), size);
  return out;
}

/** The salt length an RSA-PSS signature names, or its hash's size. */
function pssParams(params) {
  let hash = 'SHA-1';
  let salt = 20;
  for (const field of params?.children ?? []) {
    if (field.cls === 2 && field.tag === 0) hash = HASHES[oid(field.children[0].children[0])] ?? hash;
    if (field.cls === 2 && field.tag === 2) salt = Number(BigInt(`0x${toHex(content(field.children[0])) || '0'}`));
  }
  return { hash, salt };
}

/**
 * Whether a signature over some data holds for a public key.
 * @param {{spki: Uint8Array, keyAlgorithm: string, curve: ?string}} key
 * @param {string} algorithm the signature's algorithm identifier
 * @param {?string} fallbackHash the hash when the algorithm names none, as a bare RSA key does
 * @param {'der'|'raw'} ecdsaForm how an ECDSA signature is written: DER in CMS, raw in XML
 */
export async function verifySignature(key, algorithm, params, fallbackHash, data, signature, ecdsaForm = 'der') {
  const [kind, named] = SIGNATURES[algorithm] ?? [null, null];
  if (!kind) return { ok: false, problem: `an unknown signature algorithm (${algorithm})` };
  const hash = named ?? fallbackHash ?? 'SHA-256';
  try {
    if (kind === 'RSA') {
      const k = await subtle.importKey('spki', key.spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      return { ok: await subtle.verify('RSASSA-PKCS1-v1_5', k, signature, data), hash };
    }
    if (kind === 'PSS') {
      const p = pssParams(params);
      const k = await subtle.importKey('spki', key.spki, { name: 'RSA-PSS', hash: p.hash }, false, ['verify']);
      return { ok: await subtle.verify({ name: 'RSA-PSS', saltLength: p.salt }, k, signature, data), hash: p.hash };
    }
    if (!key.curve) return { ok: false, problem: 'an elliptic curve GRT does not know' };
    const k = await subtle.importKey('spki', key.spki, { name: 'ECDSA', namedCurve: key.curve }, false, ['verify']);
    const sig = ecdsaForm === 'der' ? rawEcdsa(signature, key.curve) : signature;
    return { ok: await subtle.verify({ name: 'ECDSA', hash }, k, sig, data), hash };
  } catch (error) {
    return { ok: false, problem: `a key or signature that could not be read (${error.message})` };
  }
}

/**
 * The chain from a certificate up through the ones given, each link's signature checked, ending at one the trusted list holds or at the last found.
 * @param {Object} cert from parseCertificate
 * @param {Object[]} pool certificates the signature carries
 * @param {Uint8Array[]} trusted the trusted authorities' certificates, in DER
 * @param {Date} at when the certificates had to be valid
 */
export async function checkChain(cert, pool, trusted = [], at = new Date()) {
  const anchors = trusted.map((der) => { try { return parseCertificate(der); } catch { return null; } }).filter(Boolean);
  const chain = [cert];
  const problems = [];
  let current = cert;
  let isTrusted = false;
  let expired = false;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current.notBefore && current.notAfter && (at < current.notBefore || at > current.notAfter)) {
      expired = true;
      problems.push(`the certificate of ${current.subject.common} was not valid at the time`);
    }
    if (anchors.some((a) => sameBytes(a.der, current.der))) { isTrusted = true; break; }
    const issuer = [...pool, ...anchors].find((c) => c !== current && sameBytes(c.subjectBytes, current.issuerBytes));
    if (!issuer) break;
    const [, named] = SIGNATURES[current.signatureAlgorithm] ?? [];
    const link = await verifySignature(issuer, current.signatureAlgorithm, current.signatureParams, named, current.tbs, current.signature);
    if (!link.ok) { problems.push(`the certificate of ${current.subject.common} is not signed by ${issuer.subject.common}`); break; }
    if (anchors.some((a) => sameBytes(a.der, issuer.der))) { chain.push(issuer); isTrusted = true; break; }
    if (sameBytes(issuer.der, current.der)) break;
    chain.push(issuer);
    current = issuer;
  }
  return { chain: chain.map((c) => c.subject.common), trusted: isTrusted, expired, problems };
}

/**
 * A CMS SignedData checked against the bytes it signs.
 * @param {Uint8Array} der the SignedData's ContentInfo
 * @param {Uint8Array} signedBytes what the signature is over, when detached
 * @param {Uint8Array[]} trusted the trusted authorities
 */
export async function verifyCms(der, signedBytes, trusted = []) {
  const info = parseDer(der);
  if (oid(info.children[0]) !== '1.2.840.113549.1.7.2') throw new Error('Not a signature GRT reads');
  const signed = info.children[1].children[0];
  let index = 0;
  const fields = signed.children;
  index += 1;
  const digestAlgorithms = fields[index];
  void digestAlgorithms;
  index += 1;
  const encapsulated = fields[index];
  index += 1;
  const certificates = [];
  if (fields[index]?.cls === 2 && fields[index].tag === 0) {
    for (const c of fields[index].children) { if (c.tag === 16) { try { certificates.push(parseCertificate(c.bytes)); } catch { /* not one GRT reads */ } } }
    index += 1;
  }
  if (fields[index]?.cls === 2 && fields[index].tag === 1) index += 1;
  const signerInfos = fields[index]?.children ?? [];
  const embedded = encapsulated.children?.[1]?.children?.[0];
  const data = signedBytes ?? (embedded ? content(embedded) : new Uint8Array(0));
  const results = [];
  for (const si of signerInfos) {
    const parts = si.children;
    let k = 1;
    const sid = parts[k];
    k += 1;
    let signer = null;
    if (sid.tag === 16) {
      const serial = toHex(content(sid.children[1]));
      signer = certificates.find((c) => c.serial === serial && sameBytes(c.issuerBytes, sid.children[0].bytes)) ?? certificates.find((c) => c.serial === serial);
    } else {
      signer = certificates[0] ?? null;
    }
    const hash = HASHES[oid(parts[k].children[0])] ?? 'SHA-256';
    k += 1;
    let attributes = null;
    let messageDigest = null;
    let signingTime = null;
    if (parts[k]?.cls === 2 && parts[k].tag === 0) {
      attributes = parts[k];
      for (const attribute of attributes.children) {
        const type = oid(attribute.children[0]);
        const value = attribute.children[1].children[0];
        if (type === '1.2.840.113549.1.9.4') messageDigest = content(value);
        if (type === '1.2.840.113549.1.9.5') signingTime = time(value);
      }
      k += 1;
    }
    const algorithm = parts[k];
    k += 1;
    const signature = content(parts[k]);
    const problems = [];
    if (!signer) { results.push({ signer: null, intact: false, problems: ['the signer\'s certificate is not in the file'] }); continue; }
    const computed = await digest(hash, data);
    let toVerify = data;
    let digestOk = true;
    if (attributes) {
      digestOk = messageDigest !== null && sameBytes(messageDigest, computed);
      // The signed attributes are signed as a SET, not with the tag they are stored under.
      toVerify = new Uint8Array(attributes.bytes);
      toVerify[0] = 0x31;
    }
    if (!digestOk) problems.push('the document was changed after it was signed');
    const check = await verifySignature(signer, oid(algorithm.children[0]), algorithm.children[1] ?? null, hash, toVerify, signature);
    if (!check.ok) problems.push(check.problem ?? 'the signature does not match the signer\'s key');
    if (hash === 'SHA-1') problems.push('the signature uses SHA-1, which is no longer safe');
    const chain = await checkChain(signer, certificates, trusted, signingTime ?? new Date());
    results.push({
      signer: signer.subject.common, email: signer.subject.email, issuer: signer.issuer.common, signingTime,
      intact: digestOk && check.ok, trusted: chain.trusted, expired: chain.expired, chain: chain.chain, problems: [...problems, ...chain.problems],
    });
  }
  return results;
}

/** Certificates in PEM text, such as a system's list of trusted authorities. */
export function certificatesFromPem(textValue) {
  const out = [];
  for (const m of String(textValue).matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)) {
    try { out.push(Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0))); } catch { /* skipped */ }
    if (out.length > 1000) break;
  }
  return out;
}
