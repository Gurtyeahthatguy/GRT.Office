/** Digital signatures in PDF files: each signature's byte ranges digested and its CMS checked. */

import { fromHex } from './asn1.js';
import { verifyCms } from './crypto.js';

const LATIN1 = new TextDecoder('latin1');
const MAX_SIGNATURES = 50;
const BYTE_RANGE = [...'/ByteRange'].map((c) => c.charCodeAt(0));

/** Whether a PDF has a signature at all, found without decoding the whole file. */
export function isSignedPdf(bytes) {
  outer: for (let i = bytes.indexOf(0x2f); i !== -1 && i + BYTE_RANGE.length <= bytes.length; i = bytes.indexOf(0x2f, i + 1)) {
    for (let j = 1; j < BYTE_RANGE.length; j += 1) if (bytes[i + j] !== BYTE_RANGE[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Every signature of a PDF, checked.
 * @param {Uint8Array} bytes
 * @param {Uint8Array[]} trusted the trusted authorities
 * @returns {Promise<{signer: ?string, intact: boolean, trusted: boolean, whole: boolean, signingTime: ?Date, problems: string[]}[]>}
 */
export async function verifyPdfSignatures(bytes, trusted = []) {
  const text = LATIN1.decode(bytes);
  const out = [];
  const pattern = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (const match of text.matchAll(pattern)) {
    if (out.length >= MAX_SIGNATURES) break;
    const [a, b, c, d] = match.slice(1, 5).map(Number);
    // The contents are the gap the ranges leave: a hex string between them.
    if (a !== 0 || b <= 0 || c <= b || c + d > bytes.length) {
      out.push({ signer: null, intact: false, trusted: false, whole: false, signingTime: null, problems: ['a signature whose byte ranges do not fit the file'] });
      continue;
    }
    const gap = text.slice(b, c);
    const hex = /^\s*<([0-9A-Fa-f\s]*)>\s*$/.exec(gap);
    if (!hex) {
      out.push({ signer: null, intact: false, trusted: false, whole: false, signingTime: null, problems: ['a signature whose contents are not where its byte ranges say'] });
      continue;
    }
    const der = fromHex(hex[1]);
    const signed = new Uint8Array(b + d);
    signed.set(bytes.subarray(0, b), 0);
    signed.set(bytes.subarray(c, c + d), b);
    const dictionary = text.slice(Math.max(0, match.index - 4000), match.index + 4000);
    const subFilter = /\/SubFilter\s*\/([\w.]+)/.exec(dictionary)?.[1] ?? 'adbe.pkcs7.detached';
    // The signature covers the whole file only when its last range reaches the end; later changes are named.
    const whole = c + d === bytes.length || /^\s*%%EOF\s*$/.test(text.slice(c + d));
    try {
      if (subFilter === 'adbe.x509.rsa_sha1') throw new Error('signatures of the old adbe.x509.rsa_sha1 kind are not checked');
      const results = await verifyCms(trimDer(der), subFilter === 'adbe.pkcs7.sha1' ? null : signed, trusted);
      for (const r of results) {
        out.push({ ...r, whole, problems: [...r.problems, ...(whole ? [] : ['the file was changed after this signature, by a later revision'])] });
      }
    } catch (error) {
      out.push({ signer: null, intact: false, trusted: false, whole, signingTime: null, problems: [String(error.message ?? error)] });
    }
  }
  return out;
}

/** The DER value without the zeros the gap is padded with. */
function trimDer(bytes) {
  if (bytes[0] !== 0x30) return bytes;
  let length = bytes[1];
  let header = 2;
  if (length & 0x80) {
    const size = length & 0x7f;
    length = 0;
    for (let i = 0; i < size; i += 1) length = length * 256 + bytes[2 + i];
    header = 2 + size;
  }
  return bytes.subarray(0, Math.min(bytes.length, header + length));
}
