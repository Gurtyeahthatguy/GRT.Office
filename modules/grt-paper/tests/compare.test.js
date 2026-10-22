// @vitest-environment jsdom

/** One document beside LibreOffice's reading of it: GRT_FILE=path npm test -- tests/compare.test.js */

import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOdt } from '../src/js/core/formats/odt-read.js';
import { readDocx } from '../src/js/core/formats/docx-read.js';
import { readRtf } from '../src/js/core/formats/rtf-read.js';
import { decodeBlock } from '../src/js/core/package.js';
import { DocumentModel, runsText } from '../src/js/core/editor/model.js';
import { readBlock, convert, scratch, cleanup } from '../../../scripts/oracle.mjs';

it.skipIf(!process.env.GRT_FILE)('compares one document with LibreOffice', () => {
  const file = process.env.GRT_FILE;
  let result;
  if (/\.rtf$/i.test(file)) result = readRtf(new Uint8Array(readFileSync(file)));
  else {
    const pkg = decodeBlock(readBlock(file));
    result = /\.odt$/i.test(file) ? readOdt(pkg) : readDocx(pkg);
  }
  const mine = new DocumentModel(result.document).toJSON().blocks.map((b) => (b.kind === 'list'
    ? b.items.map((i) => `  ${i.level}: ${runsText(i.runs)}`).join('\n') : `${b.kind}: ${runsText(b.runs ?? b.caption ?? [])}`)).join('\n');
  const dir = scratch();
  const theirs = readFileSync(convert(file, 'txt:Text (encoded):UTF8', join(dir, 'x')), 'utf8');
  cleanup(dir);
  console.log(`--- OURS\n${mine}\n--- LIBREOFFICE\n${theirs}\n--- LOST\n${result.losses.lines().join('\n')}`);
});
