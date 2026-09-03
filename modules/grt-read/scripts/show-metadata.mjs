/** Prints everything identifying that a PDF carries. */

import { readFileSync } from 'node:fs';
import { inflateSync, constants } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/show-metadata.mjs <file.pdf>');
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
const doc = await PDFDocument.load(bytes, {
  updateMetadata: false,
  ignoreEncryption: true,
});

const show = (label, value) => {
  const empty = value === undefined || value === null || value === '';
  console.log(`  ${label.padEnd(18)} ${empty ? '(empty)' : value}`);
};

console.log(`\n${path}`);
console.log(`  ${'size'.padEnd(18)} ${bytes.length} bytes`);
console.log(`  ${'pages'.padEnd(18)} ${doc.getPageCount()}`);
console.log('\n/Info dictionary');
show('Title', doc.getTitle());
show('Author', doc.getAuthor());
show('Subject', doc.getSubject());
show('Keywords', doc.getKeywords());
show('Creator', doc.getCreator());
show('Producer', doc.getProducer());
show('CreationDate', doc.getCreationDate()?.toISOString());
show('ModDate', doc.getModificationDate()?.toISOString());

const raw = new TextDecoder('latin1').decode(bytes);
console.log('\nOther traces');
console.log(`  ${'XMP block'.padEnd(18)} ${raw.includes('xmpmeta') ? 'PRESENT' : 'absent'}`);
console.log(`  ${'trailers (%%EOF)'.padEnd(18)} ${raw.split('%%EOF').length - 1}`);

// Anything that looks like a home directory or a known generator name.
const suspicious = ['pdf-lib', 'Microsoft', 'Acrobat', 'Skia', 'LibreOffice',
  'C:\\Users\\', '/home/', '/Users/'];
const hits = suspicious.filter((term) => raw.includes(term));
console.log(`  ${'known strings'.padEnd(18)} ${hits.length ? hits.join(', ') : 'none'}`);

// Embedded JPEGs keep the EXIF block they arrived with.
let exif = 0;
let cursor = 0;
while (true) {
  const start = raw.indexOf('stream', cursor);
  if (start === -1) break;
  cursor = start + 6;
  if (raw.slice(start - 3, start) === 'end') continue;
  let dataStart = start + 6;
  if (raw[dataStart] === '\r') dataStart += 1;
  if (raw[dataStart] === '\n') dataStart += 1;
  const end = raw.indexOf('endstream', dataStart);
  if (end === -1) break;
  const slice = raw.slice(dataStart, Math.min(dataStart + 4096, end));
  if (slice.includes('Exif\0')) exif += 1;
  try {
    const out = inflateSync(bytes.subarray(dataStart, end), {
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    if (new TextDecoder('latin1').decode(out.subarray(0, 4096)).includes('Exif\0')) exif += 1;
  } catch { /** not deflate. */ }
}
console.log(`  ${'images with EXIF'.padEnd(18)} ${exif}`);
console.log();
