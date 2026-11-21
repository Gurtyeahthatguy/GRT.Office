/** XML signatures, as OpenDocument and Office files carry them: references digested, the signed information canonicalised and checked. */

import { fromBase64, sameBytes } from './asn1.js';
import { parseCertificate, verifySignature, checkChain, digest } from './crypto.js';
import { parseXml } from '../xml.js';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const INCLUSIVE = ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments'];
const EXCLUSIVE = ['http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments'];
const DIGESTS = {
  'http://www.w3.org/2000/09/xmldsig#sha1': 'SHA-1', 'http://www.w3.org/2001/04/xmlenc#sha256': 'SHA-256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384': 'SHA-384', 'http://www.w3.org/2001/04/xmlenc#sha512': 'SHA-512',
};
const METHODS = {
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': '1.2.840.113549.1.1.5', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': '1.2.840.113549.1.1.11',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': '1.2.840.113549.1.1.12', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': '1.2.840.113549.1.1.13',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256': '1.2.840.10045.4.3.2', 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384': '1.2.840.10045.4.3.3',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512': '1.2.840.10045.4.3.4',
};
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/RelationshipTransform';
const MAX_REFERENCES = 2000;

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

/** The namespaces in scope at an element: its own declarations over its ancestors'. */
function inScope(element) {
  const chain = [];
  for (let e = element; e && e.nodeType === 1; e = e.parentNode) chain.unshift(e);
  const map = new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]);
  for (const e of chain) {
    for (const a of e.attributes) {
      if (a.namespaceURI !== XMLNS) continue;
      map.set(a.prefix === 'xmlns' ? a.localName : '', a.value);
    }
  }
  return map;
}

/**
 * Canonical XML of a node: inclusive 1.0, or exclusive with the prefixes it must keep, comments left out.
 * @param {Node} node a document or an element
 */
export function canonicalize(node, { exclusive = false, prefixes = [], comments = false } = {}) {
  const parts = [];
  const element = (e, rendered) => {
    const scope = inScope(e);
    const own = new Map(rendered);
    const declarations = [];
    const prefixOf = (q) => (q.includes(':') ? q.split(':')[0] : '');
    if (exclusive) {
      // Only the namespaces the element or its attributes use, and those named to be kept.
      const used = new Set([prefixOf(e.tagName)]);
      for (const a of e.attributes) if (a.namespaceURI !== XMLNS && a.name.includes(':') && !a.name.startsWith('xml:')) used.add(prefixOf(a.name));
      for (const p of prefixes) used.add(p === '#default' ? '' : p);
      for (const prefix of used) {
        if (prefix === 'xml') continue;
        const uri = scope.get(prefix) ?? '';
        if (own.get(prefix) === uri || (prefix === '' && uri === '' && !own.has(''))) continue;
        declarations.push([prefix, uri]);
        own.set(prefix, uri);
      }
    } else {
      for (const [prefix, uri] of scope) {
        if (prefix === 'xml') continue;
        if (own.get(prefix) === uri) continue;
        if (prefix === '' && uri === '' && !own.has('')) continue;
        declarations.push([prefix, uri]);
        own.set(prefix, uri);
      }
    }
    declarations.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const attributes = [...e.attributes].filter((a) => a.namespaceURI !== XMLNS)
      .sort((a, b) => {
        const ua = a.namespaceURI ?? '';
        const ub = b.namespaceURI ?? '';
        if (ua !== ub) return ua < ub ? -1 : 1;
        return a.localName < b.localName ? -1 : a.localName > b.localName ? 1 : 0;
      });
    parts.push(`<${e.tagName}`);
    for (const [prefix, uri] of declarations) parts.push(prefix ? ` xmlns:${prefix}="${escapeAttr(uri)}"` : ` xmlns="${escapeAttr(uri)}"`);
    for (const a of attributes) parts.push(` ${a.name}="${escapeAttr(a.value)}"`);
    parts.push('>');
    for (const child of e.childNodes) visit(child, own);
    parts.push(`</${e.tagName}>`);
  };
  const visit = (n, rendered) => {
    if (n.nodeType === 1) element(n, rendered);
    else if (n.nodeType === 3 || n.nodeType === 4) parts.push(escapeText(n.nodeValue));
    else if (n.nodeType === 7) parts.push(`<?${n.target}${n.data ? ` ${n.data}` : ''}?>`);
    else if (n.nodeType === 8 && comments) parts.push(`<!--${n.data}-->`);
  };
  if (node.nodeType === 9) {
    // Before the root and after it, processing instructions each on a line of their own.
    let seenRoot = false;
    for (const child of node.childNodes) {
      if (child.nodeType === 1) { seenRoot = true; element(child, new Map()); } else if (child.nodeType === 7 || (child.nodeType === 8 && comments)) {
        if (seenRoot) parts.push('\n');
        visit(child, new Map());
        if (!seenRoot) parts.push('\n');
      }
    }
  } else {
    // An element apart from its document: inclusively, what its ancestors declare comes with it.
    element(node, new Map());
  }
  return new TextEncoder().encode(parts.join(''));
}

/** The children of an element in a namespace, by local name. */
const kids = (e, name, ns = DSIG) => [...(e?.children ?? [])].filter((c) => c.localName === name && c.namespaceURI === ns);
const kid = (e, name, ns = DSIG) => kids(e, name, ns)[0] ?? null;

/** An element of a document by its Id, as same-document references name them; an Id found twice names none, so a copy cannot stand in for the signed one. */
function byId(doc, id) {
  const found = [...doc.getElementsByTagName('*')].filter((e) => e.getAttribute('Id') === id || e.getAttribute('id') === id);
  return found.length === 1 ? found[0] : null;
}

/** The package path a reference names, without its query. */
function pathOf(uri) {
  const bare = uri.replace(/\?.*$/, '').replace(/^\//, '');
  try { return decodeURIComponent(bare); } catch { return bare; }
}

/** The first date and time in a text, its zone honoured; a time without a zone, as LibreOffice writes, is read as UTC. */
function timeOf(text) {
  const m = /(\d{4}-\d\d-\d\d)T?(\d\d:\d\d:\d\d)(?:[.,]\d+)?(Z|[+-]\d\d:?\d\d)?/.exec(text ?? '');
  if (!m) return null;
  const zone = !m[3] || m[3] === 'Z' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`;
  const value = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(value) ? null : new Date(value);
}

const xmlOf = (bytes, what) => parseXml(new TextDecoder().decode(bytes), what);

/** The relationships a transform selects, sorted and canonicalised as the Office format asks. */
function relationshipTransform(bytes, transform) {
  const ids = new Set();
  const types = new Set();
  for (const r of transform.getElementsByTagName('*')) {
    if (r.localName === 'RelationshipReference') ids.add(r.getAttribute('SourceId'));
    if (r.localName === 'RelationshipsGroupReference') types.add(r.getAttribute('SourceType'));
  }
  const doc = xmlOf(bytes, 'a signed list of relationships');
  const rels = [...doc.getElementsByTagName('*')].filter((e) => e.localName === 'Relationship' && (ids.has(e.getAttribute('Id')) || types.has(e.getAttribute('Type'))))
    .sort((a, b) => (a.getAttribute('Id') < b.getAttribute('Id') ? -1 : 1));
  const out = rels.map((r) => `<Relationship Id="${escapeAttr(r.getAttribute('Id') ?? '')}" Target="${escapeAttr(r.getAttribute('Target') ?? '')}" TargetMode="${escapeAttr(r.getAttribute('TargetMode') ?? 'Internal')}" Type="${escapeAttr(r.getAttribute('Type') ?? '')}"></Relationship>`).join('');
  return new TextEncoder().encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${out}</Relationships>`);
}

/** The bytes a reference covers, its transforms applied. */
async function referencedBytes(reference, doc, resolve) {
  const uri = reference.getAttribute('URI') ?? '';
  const transforms = kids(kid(reference, 'Transforms'), 'Transform');
  let target;
  if (uri.startsWith('#')) {
    const e = byId(doc, uri.slice(1));
    if (!e) return null;
    target = { element: e };
  } else {
    const bytes = await resolve(pathOf(uri));
    if (!bytes) return null;
    target = { bytes };
  }
  let out = target.bytes ?? null;
  let nodeForm = target.element ?? null;
  for (const t of transforms) {
    const algorithm = t.getAttribute('Algorithm');
    if (algorithm === 'http://www.w3.org/2000/09/xmldsig#enveloped-signature') continue;
    if (algorithm === RELATIONSHIPS) { out = relationshipTransform(out, t); nodeForm = null; continue; }
    if (INCLUSIVE.includes(algorithm) || EXCLUSIVE.includes(algorithm)) {
      const exclusive = EXCLUSIVE.includes(algorithm);
      const comments = algorithm.endsWith('#WithComments');
      const list = [...t.getElementsByTagName('*')].find((x) => x.localName === 'InclusiveNamespaces')?.getAttribute('PrefixList')?.split(/\s+/).filter(Boolean) ?? [];
      if (nodeForm) out = canonicalize(nodeForm, { exclusive, prefixes: list, comments });
      else if (out) out = canonicalize(xmlOf(out, `the signed part ${uri}`), { exclusive, prefixes: list, comments });
      nodeForm = null;
      continue;
    }
    return null;
  }
  // A same-document reference without a transform is canonicalised as XML is, without comments.
  if (nodeForm) out = canonicalize(nodeForm);
  return out;
}

/**
 * One XML signature checked: each reference's digest, the signature over the signed information, the signer's chain.
 * @param {Element} signature a ds:Signature element
 * @param {(path: string) => Promise<?Uint8Array>} resolve a file of the package by its path
 * @param {Uint8Array[]} trusted
 */
export async function verifyXmlSignature(signature, resolve, trusted = []) {
  const doc = signature.ownerDocument;
  const info = kid(signature, 'SignedInfo');
  const problems = [];
  const references = [...kids(info, 'Reference')];
  // References in a manifest the signature covers are checked too, as Office signs its parts that way.
  for (const manifest of [...signature.getElementsByTagNameNS(DSIG, 'Manifest')]) references.push(...kids(manifest, 'Reference'));
  let referencesOk = true;
  const covered = [];
  for (const reference of references.slice(0, MAX_REFERENCES)) {
    const uri = reference.getAttribute('URI') ?? '';
    const hash = DIGESTS[kid(reference, 'DigestMethod')?.getAttribute('Algorithm')];
    if (!hash) { referencesOk = false; problems.push(`a part digested in a way GRT does not know (${uri})`); continue; }
    let bytes = null;
    try { bytes = await referencedBytes(reference, doc, resolve); } catch { bytes = null; }
    if (!bytes) { referencesOk = false; problems.push(`a signed part that is missing or cannot be read: ${uri}`); continue; }
    const expected = fromBase64(kid(reference, 'DigestValue')?.textContent ?? '');
    if (!sameBytes(await digest(hash, bytes), expected)) { referencesOk = false; problems.push(`${uri.replace(/\?.*$/, '') || 'a part'} was changed after it was signed`); }
    if (!uri.startsWith('#')) covered.push(pathOf(uri));
  }
  const certificates = [...signature.getElementsByTagNameNS(DSIG, 'X509Certificate')].map((c) => { try { return parseCertificate(fromBase64(c.textContent)); } catch { return null; } }).filter(Boolean);
  const signer = certificates[0] ?? null;
  const time = [...signature.getElementsByTagName('*')].filter((e) => ['SigningTime', 'SignatureTime', 'date'].includes(e.localName)).map((e) => e.textContent).join(' ');
  const signingTime = timeOf(time);
  if (!signer) return { signer: null, intact: false, trusted: false, covered, signingTime, problems: [...problems, 'the signer\'s certificate is not in the file'] };
  const method = kid(info, 'SignatureMethod')?.getAttribute('Algorithm');
  const algorithm = METHODS[method];
  const canonical = kid(info, 'CanonicalizationMethod')?.getAttribute('Algorithm') ?? INCLUSIVE[0];
  let signatureOk = false;
  if (!algorithm) problems.push(`a signature method GRT does not know (${method})`);
  else {
    const exclusive = EXCLUSIVE.includes(canonical);
    const prefixes = [...kid(info, 'CanonicalizationMethod').getElementsByTagName('*')].find((x) => x.localName === 'InclusiveNamespaces')?.getAttribute('PrefixList')?.split(/\s+/).filter(Boolean) ?? [];
    const check = await verifySignature(signer, algorithm, null, null, canonicalize(info, { exclusive, prefixes }), fromBase64(kid(signature, 'SignatureValue')?.textContent ?? ''), 'raw');
    signatureOk = check.ok;
    if (!check.ok) problems.push(check.problem ?? 'the signature does not match the signer\'s key');
    if (check.hash === 'SHA-1') problems.push('the signature uses SHA-1, which is no longer safe');
  }
  const chain = await checkChain(signer, certificates, trusted, signingTime ?? new Date());
  return {
    signer: signer.subject.common, email: signer.subject.email, issuer: signer.issuer.common, signingTime,
    intact: referencesOk && signatureOk, trusted: chain.trusted, expired: chain.expired, chain: chain.chain, covered, problems: [...problems, ...chain.problems],
  };
}

/**
 * The signatures of an OpenDocument package.
 * @param {(path: string) => ?Uint8Array} read a file of the package
 * @param {string[]} paths every file of the package, to say which the signatures leave out
 */
export async function verifyOdfSignatures(read, paths = [], trusted = []) {
  const xml = read('META-INF/documentsignatures.xml');
  if (!xml) return [];
  let doc;
  try { doc = xmlOf(xml, 'the signatures'); } catch (error) { return [{ signer: null, intact: false, trusted: false, covered: [], signingTime: null, problems: [error.message] }]; }
  const out = [];
  for (const signature of [...doc.getElementsByTagNameNS(DSIG, 'Signature')].slice(0, 50)) {
    const result = await verifyXmlSignature(signature, async (path) => read(path), trusted);
    const left = paths.filter((p) => !p.endsWith('/') && !p.startsWith('META-INF/') && p !== 'mimetype' && !result.covered.includes(p));
    if (left.length) result.problems.push(`parts not covered by the signature: ${left.slice(0, 5).join(', ')}`);
    out.push(result);
  }
  return out;
}

/** The signatures of an Office package, found through its signature origin. */
export async function verifyOoxmlSignatures(read, paths = [], trusted = []) {
  const out = [];
  for (const path of paths.filter((p) => /^_xmlsignatures\/[^/]+\.xml$/.test(p)).slice(0, 50)) {
    let doc;
    try { doc = xmlOf(read(path), 'a signature'); } catch (error) { out.push({ signer: null, intact: false, trusted: false, covered: [], signingTime: null, problems: [error.message] }); continue; }
    const signature = doc.getElementsByTagNameNS(DSIG, 'Signature')[0];
    if (!signature) continue;
    out.push(await verifyXmlSignature(signature, async (p) => read(p), trusted));
  }
  return out;
}
