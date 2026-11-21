/** XML signatures of OpenDocument and Office files, made with OpenSSL and canonicalised by libxml2, checked by GRT. */

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize, verifyOdfSignatures, verifyOoxmlSignatures } from '../src/js/core/signatures/xml.js';
import { packageSignatures, addTrusted, trustedOf, signatureLoss, noteSignatures } from '../src/js/core/signatures/ui.js';
import { Package } from '../src/js/core/package.js';
import { Losses } from '../src/js/core/losses.js';

const tools = ['openssl', 'xmllint'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0);
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
let dir;

const enc = (s) => new TextEncoder().encode(s);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('base64');

/** libxml2's canonical form of a document, inclusive or exclusive; Windows' xmllint writes CRLF, which canonical form never holds. */
function libxml(xml, exclusive = false) {
  writeFileSync(join(dir, 'c14n.xml'), xml);
  const out = execFileSync('xmllint', [exclusive ? '--exc-c14n' : '--c14n', join(dir, 'c14n.xml')]);
  return Buffer.from(out.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/** A signature by OpenSSL over some bytes, ECDSA turned from DER into the raw pair XML carries. */
function sign(key, bytes, ec = false) {
  writeFileSync(join(dir, 'signed'), bytes);
  const der = execFileSync('openssl', ['dgst', '-sha256', '-sign', key, join(dir, 'signed')]);
  if (!ec) return der.toString('base64');
  const r = der.subarray(4, 4 + der[3]);
  const s = der.subarray(6 + der[3], 6 + der[3] + der[5 + der[3]]);
  const fit = (n) => Buffer.concat([Buffer.alloc(32), n.subarray(n[0] === 0 ? 1 : 0)]).subarray(-32);
  return Buffer.concat([fit(r), fit(s)]).toString('base64');
}

const certificate = (pem) => execFileSync('openssl', ['x509', '-in', pem, '-outform', 'DER']).toString('base64');
const pemDer = (pem) => new Uint8Array(execFileSync('openssl', ['x509', '-in', pem, '-outform', 'DER']));

const CONTENT = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:text><text:p text:style-name="P1">Ciao &amp; &lt;mondo&gt;</text:p></office:text></office:body></office:document-content>';

/** An OpenDocument package as a map of paths, signed the way LibreOffice signs. */
function signedOdt({ content = CONTENT, picture = new Uint8Array([1, 2, 3, 4]) } = {}) {
  const files = { mimetype: enc('application/vnd.oasis.opendocument.text'), 'content.xml': enc(content), 'Pictures/a.png': picture };
  const references = [
    `<Reference URI="content.xml"><Transforms><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>${sha256(libxml(CONTENT))}</DigestValue></Reference>`,
    `<Reference URI="Pictures/a.png"><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>${sha256(new Uint8Array([1, 2, 3, 4]))}</DigestValue></Reference>`,
  ].join('');
  const info = `<SignedInfo xmlns="${DSIG}"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>${references}</SignedInfo>`;
  const value = sign(join(dir, 'rsa.key'), libxml(info));
  const signatures = `<?xml version="1.0" encoding="UTF-8"?>\n<document-signatures xmlns="urn:oasis:names:tc:opendocument:xmlns:digitalsignature:1.0"><Signature xmlns="${DSIG}" Id="ID_1">${info.replace(` xmlns="${DSIG}"`, '')}<SignatureValue>${value}</SignatureValue><KeyInfo><X509Data><X509Certificate>${certificate(join(dir, 'rsa.pem'))}</X509Certificate></X509Data></KeyInfo><Object><SignatureProperties><SignatureProperty Id="p1" Target="#ID_1"><dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">${LATER}.5</dc:date></SignatureProperty></SignatureProperties></Object></Signature></document-signatures>`;
  files['META-INF/documentsignatures.xml'] = enc(signatures);
  return files;
}

// A day after the certificates are made, within their thirty days.
const LATER = new Date(Date.now() + 86400000).toISOString().slice(0, 19);

const odfResult = (files, trusted) => verifyOdfSignatures((p) => files[p] ?? null, Object.keys(files), trusted);

describe.skipIf(!tools)('XML signatures', () => {
  beforeAll(() => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
    dir = mkdtempSync(join(tmpdir(), 'grt-xmlsig-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'rsa.key'), '-out', join(dir, 'rsa.pem'), '-days', '30', '-subj', '/CN=Mario Rossi'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'ec.key'), '-out', join(dir, 'ec.pem'), '-days', '30', '-subj', '/CN=Anna Bianchi'], { stdio: 'ignore' });
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('the canonical form is the one libxml2 makes, inclusive and exclusive', () => {
    const xml = '<?xml version="1.0"?>\n<?pi data?>\n<a:root xmlns:b="urn:b" xmlns:a="urn:a" xmlns="urn:d" z="1" b:y="2" a:x="3"><!-- c --><child   attr="t\u0009ab &quot;q&quot;" ><x:y xmlns:x="urn:x" xmlns:a="urn:a">t&amp;&gt;<![CDATA[<raw>]]></x:y><e xmlns=""/></child></a:root>';
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(new TextDecoder().decode(canonicalize(doc, { comments: true }))).toBe(libxml(xml).toString());
    expect(new TextDecoder().decode(canonicalize(doc, { exclusive: true, comments: true }))).toBe(libxml(xml, true).toString());
  });

  it('a signed OpenDocument file is intact, its signer and date read, trusted only through its authority', async () => {
    const files = signedOdt();
    const [result] = await odfResult(files);
    expect(result).toMatchObject({ signer: 'Mario Rossi', intact: true, trusted: false });
    expect(result.signingTime.toISOString()).toBe(`${LATER}.000Z`);
    expect(result.problems).toEqual([]);
    const [trusted] = await odfResult(files, [pemDer(join(dir, 'rsa.pem'))]);
    expect(trusted.trusted).toBe(true);
  });

  it('a changed part, a changed picture, an added part and a forged signature are all named', async () => {
    const files = signedOdt();
    const changed = { ...files, 'content.xml': enc(CONTENT.replace('Ciao', 'Addio')) };
    expect((await odfResult(changed))[0]).toMatchObject({ intact: false });
    expect((await odfResult(changed))[0].problems.join()).toMatch(/content\.xml was changed/);
    const picture = { ...files, 'Pictures/a.png': new Uint8Array([9, 9]) };
    expect((await odfResult(picture))[0].intact).toBe(false);
    const added = { ...files, 'Pictures/b.png': new Uint8Array([5]) };
    const [plus] = await odfResult(added);
    expect(plus.intact).toBe(true);
    expect(plus.problems.join()).toMatch(/not covered.*Pictures\/b\.png/);
    // The same references in other words: a whitespace inside a tag is canonicalised away, the digest still holds.
    const spaced = { ...files, 'content.xml': enc(CONTENT.replace('<office:body>', '<office:body  >')) };
    expect((await odfResult(spaced))[0].intact).toBe(true);
    const text = new TextDecoder().decode(files['META-INF/documentsignatures.xml']);
    const forged = { ...files, 'META-INF/documentsignatures.xml': enc(text.replace(/<SignatureValue>(.)/, (m, c) => `<SignatureValue>${c === 'A' ? 'B' : 'A'}`)) };
    expect((await odfResult(forged))[0].intact).toBe(false);
  });

  it('a signatures file that is not XML, or declares entities, is reported, never thrown', async () => {
    const bad = { 'META-INF/documentsignatures.xml': enc('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>') };
    const [result] = await odfResult(bad);
    expect(result.intact).toBe(false);
    expect(result.problems[0]).toMatch(/entities/);
  });

  it('an Office file signed with ECDSA through a manifest and a relationship transform is intact; a changed relationship is not', async () => {
    const files = {
      '[Content_Types].xml': enc('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      'word/document.xml': enc('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ciao</w:t></w:r></w:p></w:body></w:document>'),
      'word/_rels/document.xml.rels': enc('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://x/styles" Target="styles.xml" Id="rId2"/><Relationship Id="rId1" Target="http://example.org" TargetMode="External" Type="http://x/hyperlink"/></Relationships>'),
    };
    // The relationship transform's output as the Office format describes it, written out by hand.
    const relsCanonical = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="http://example.org" TargetMode="External" Type="http://x/hyperlink"></Relationship><Relationship Id="rId2" Target="styles.xml" TargetMode="Internal" Type="http://x/styles"></Relationship></Relationships>';
    const manifest = `<Manifest><Reference URI="/word/document.xml?ContentType=application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>${sha256(files['word/document.xml'])}</DigestValue></Reference><Reference URI="/word/_rels/document.xml.rels?ContentType=application/vnd.openxmlformats-package.relationships+xml"><Transforms><Transform Algorithm="http://schemas.openxmlformats.org/package/2006/RelationshipTransform"><mdssi:RelationshipReference xmlns:mdssi="http://schemas.openxmlformats.org/package/2006/digital-signature" SourceId="rId1"/><mdssi:RelationshipReference xmlns:mdssi="http://schemas.openxmlformats.org/package/2006/digital-signature" SourceId="rId2"/></Transform><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>${sha256(enc(relsCanonical))}</DigestValue></Reference></Manifest>`;
    const object = `<Object Id="idPackageObject">${manifest}<SignatureProperties><SignatureProperty Id="idTime" Target="#idSig"><mdssi:SignatureTime xmlns:mdssi="http://schemas.openxmlformats.org/package/2006/digital-signature"><mdssi:Format>YYYY-MM-DDThh:mm:ssTZD</mdssi:Format><mdssi:Value>${LATER}Z</mdssi:Value></mdssi:SignatureTime></SignatureProperty></SignatureProperties></Object>`;
    const objectDigest = sha256(libxml(object.replace('<Object ', `<Object xmlns="${DSIG}" `)));
    const info = `<SignedInfo xmlns="${DSIG}"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/><Reference Type="http://www.w3.org/2000/09/xmldsig#Object" URI="#idPackageObject"><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>${objectDigest}</DigestValue></Reference></SignedInfo>`;
    const value = sign(join(dir, 'ec.key'), libxml(info), true);
    files['_xmlsignatures/sig1.xml'] = enc(`<?xml version="1.0" encoding="UTF-8"?>\n<Signature xmlns="${DSIG}" Id="idSig">${info.replace(` xmlns="${DSIG}"`, '')}<SignatureValue>${value}</SignatureValue><KeyInfo><X509Data><X509Certificate>${certificate(join(dir, 'ec.pem'))}</X509Certificate></X509Data></KeyInfo>${object}</Signature>`);
    const read = (f) => (p) => f[p] ?? null;
    const [result] = await verifyOoxmlSignatures(read(files), Object.keys(files));
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({ signer: 'Anna Bianchi', intact: true });
    expect(result.signingTime.toISOString()).toBe(`${LATER}.000Z`);
    expect(result.covered).toEqual(['word/document.xml', 'word/_rels/document.xml.rels']);
    const moved = { ...files, 'word/_rels/document.xml.rels': enc(new TextDecoder().decode(files['word/_rels/document.xml.rels']).replace('http://example.org', 'http://evil.example')) };
    expect((await verifyOoxmlSignatures(read(moved), Object.keys(moved)))[0].intact).toBe(false);
    // A relationship the signature does not select may be added freely, as Office allows.
    const extra = { ...files, 'word/_rels/document.xml.rels': enc(new TextDecoder().decode(files['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rId9" Type="http://x/other" Target="o.xml"/></Relationships>')) };
    expect((await verifyOoxmlSignatures(read(extra), Object.keys(extra)))[0].intact).toBe(true);
    // A copy of the signed object under the same Id is refused rather than guessed between.
    const wrapped = { ...files, '_xmlsignatures/sig1.xml': enc(new TextDecoder().decode(files['_xmlsignatures/sig1.xml']).replace('</Signature>', `${object}</Signature>`)) };
    expect((await verifyOoxmlSignatures(read(wrapped), Object.keys(wrapped)))[0].intact).toBe(false);
  });

  it('an opened package names its signatures among what saving loses, and trust is added from a PEM file', async () => {
    const files = signedOdt();
    const pkg = new Package(new Map(Object.entries(files)));
    const losses = new Losses();
    expect(await noteSignatures(pkg, losses, {})).toBe(pkg);
    expect(losses.lines()[0]).toMatch(/^Signed by Mario Rossi: valid, but its authority is not among the trusted ones\. GRT checks digital signatures and does not make them/);
    expect(await noteSignatures(new Package(new Map([['content.xml', enc(CONTENT)]])), new Losses(), {})).toBeNull();
    const pem = readFileSync(join(dir, 'rsa.pem'));
    const { list, added } = addTrusted([], new Uint8Array(pem));
    expect(added).toEqual(['Mario Rossi']);
    expect(addTrusted(list, new Uint8Array(pem)).added).toEqual([]);
    expect(addTrusted(list, enc('not a certificate')).list).toEqual(list);
    const [trusted] = await packageSignatures(pkg, trustedOf({ trustedCertificates: list }));
    expect(trusted.trusted).toBe(true);
    expect(signatureLoss([trusted])).toMatch(/valid, from a trusted authority/);
    expect(trustedOf({ trustedCertificates: 'nonsense' })).toEqual([]);
  });
});
