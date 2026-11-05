/** The vendored pdf-lib refuses a stream that unpacks to more than 256 MB, instead of growing until memory runs out. */

import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PDFContext, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from '../src/vendor/pdf-lib.esm.js';

/** A FlateDecode stream of `size` zero bytes, built from one compressed block repeated. */
function zeros(size) {
  const context = PDFContext.create();
  const dict = PDFDict.withContext(context);
  dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  return PDFRawStream.of(dict, deflateSync(Buffer.alloc(size), { level: 9 }));
}

describe('the stream limit', () => {
  it('unpacks an ordinary stream', () => {
    expect(decodePDFRawStream(zeros(1024 * 1024)).decode().length).toBe(1024 * 1024);
  });

  it('refuses a stream that unpacks past 256 MB', () => {
    expect(() => decodePDFRawStream(zeros(300 * 1024 * 1024)).decode()).toThrow(/more than 256 MB/);
  }, 60000);
});
