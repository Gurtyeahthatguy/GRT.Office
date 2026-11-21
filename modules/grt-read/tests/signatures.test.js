/** Digital signatures in PDF files, made by OpenSSL, checked by GRT: intact, changed, trusted or not. */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyPdfSignatures, isSignedPdf } from '../src/js/core/signatures/pdf.js';

const hasOpenssl = spawnSync('sh', ['-c', 'command -v openssl']).status === 0;
let dir;

/** A one-page PDF with a signature field whose contents OpenSSL fills. */
function signedPdf(key, cert) {
  const placeholder = '0'.repeat(16384);
  const body = [
    '%PDF-1.7',
    '1 0 obj << /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >> >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >> endobj',
    '4 0 obj << /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /V 5 0 R /T (Signature1) /P 3 0 R >> endobj',
    `5 0 obj << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 BBBBBBBBBB CCCCCCCCCC DDDDDDDDDD] /Contents <${placeholder}> >> endobj`,
    'trailer << /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n');
  const b = body.indexOf('<0000');
  const c = body.indexOf('>', b) + 1;
  const d = body.length - c;
  const pad = (n) => String(n).padEnd(10, ' ');
  const text = body.replace('BBBBBBBBBB', pad(b)).replace('CCCCCCCCCC', pad(c)).replace('DDDDDDDDDD', pad(d));
  const bytes = Buffer.from(text, 'latin1');
  writeFileSync(join(dir, 'data'), Buffer.concat([bytes.subarray(0, b), bytes.subarray(c)]));
  execFileSync('openssl', ['cms', '-sign', '-binary', '-in', join(dir, 'data'), '-signer', cert, '-inkey', key, '-outform', 'DER', '-md', 'sha256', '-out', join(dir, 'sig.der')]);
  const hex = readFileSync(join(dir, 'sig.der')).toString('hex').toUpperCase();
  const filled = text.replace(placeholder, hex.padEnd(placeholder.length, '0'));
  return new Uint8Array(Buffer.from(filled, 'latin1'));
}

const der = (pem) => new Uint8Array(execFileSync('openssl', ['x509', '-in', pem, '-outform', 'DER']));

describe.skipIf(!hasOpenssl)('PDF signatures', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'grt-sig-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'rsa.key'), '-out', join(dir, 'rsa.pem'), '-days', '30', '-subj', '/CN=Mario Rossi/O=Prova'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(dir, 'ec.key'), '-out', join(dir, 'ec.pem'), '-days', '30', '-subj', '/CN=Anna Bianchi'], { stdio: 'ignore' });
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('an RSA signature over the whole file is intact, its signer named, not trusted unless its authority is', async () => {
    const pdf = signedPdf(join(dir, 'rsa.key'), join(dir, 'rsa.pem'));
    expect(isSignedPdf(pdf)).toBe(true);
    expect(isSignedPdf(new TextEncoder().encode('%PDF-1.7 /ByteRang /Byte'))).toBe(false);
    const [result] = await verifyPdfSignatures(pdf);
    expect(result).toMatchObject({ signer: 'Mario Rossi', intact: true, whole: true, trusted: false });
    expect(result.signingTime).toBeInstanceOf(Date);
    const [trusted] = await verifyPdfSignatures(pdf, [der(join(dir, 'rsa.pem'))]);
    expect(trusted.trusted).toBe(true);
    expect(trusted.problems).toEqual([]);
  });

  it('an ECDSA signature is checked as well', async () => {
    const [result] = await verifyPdfSignatures(signedPdf(join(dir, 'ec.key'), join(dir, 'ec.pem')));
    expect(result).toMatchObject({ signer: 'Anna Bianchi', intact: true });
  });

  it('a changed byte breaks the signature, and the change is said', async () => {
    const pdf = signedPdf(join(dir, 'rsa.key'), join(dir, 'rsa.pem'));
    const at = Buffer.from(pdf).indexOf('200 200');
    pdf[at] = '3'.charCodeAt(0);
    const [result] = await verifyPdfSignatures(pdf);
    expect(result.intact).toBe(false);
    expect(result.problems.join()).toMatch(/changed after it was signed/);
  });

  it('a revision added after signing is named', async () => {
    const pdf = signedPdf(join(dir, 'rsa.key'), join(dir, 'rsa.pem'));
    const more = new Uint8Array([...pdf, ...Buffer.from('6 0 obj << >> endobj\n%%EOF\n')]);
    const [result] = await verifyPdfSignatures(more);
    expect(result.intact).toBe(true);
    expect(result.whole).toBe(false);
  });

  it('an expired certificate, an altered file and a good signature give three different answers', async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'old.key'), '-out', join(dir, 'old.pem'), '-not_before', '20200101000000Z', '-not_after', '20200201000000Z', '-subj', '/CN=Vecchio'], { stdio: 'ignore' });
    const [old] = await verifyPdfSignatures(signedPdf(join(dir, 'old.key'), join(dir, 'old.pem')));
    expect(old).toMatchObject({ signer: 'Vecchio', intact: true, expired: true });
    const [good] = await verifyPdfSignatures(signedPdf(join(dir, 'rsa.key'), join(dir, 'rsa.pem')));
    expect(good).toMatchObject({ intact: true, expired: false });
    const altered = signedPdf(join(dir, 'rsa.key'), join(dir, 'rsa.pem'));
    altered[20] ^= 1;
    const [bad] = await verifyPdfSignatures(altered);
    expect(bad.intact).toBe(false);
  });
});

describe('DER that a signed file could hold', () => {
  it('a value cut inside its header, or a long name, gives an error or the text, never a RangeError', async () => {
    const { parseDer, text } = await import('../src/js/core/signatures/asn1.js');
    for (const cut of [[0x30, 0x82, 0x01], [0x30, 0x81], [0x30, 0x03, 0x02]]) expect(() => parseDer(Uint8Array.from(cut))).toThrow(/damaged/);
    const length = 300000;
    const long = new Uint8Array(5 + length).fill(0x41);
    long.set([0x13, 0x83, length >> 16, (length >> 8) & 0xff, length & 0xff]);
    expect(text(parseDer(long))).toHaveLength(length);
  });
});
