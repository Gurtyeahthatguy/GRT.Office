/** Copies the third-party libraries into src/vendor/. */

import { copyFileSync, cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const vendor = join(root, 'src', 'vendor');

const pkgVersion = (name) =>
  JSON.parse(readFileSync(join(nm, name, 'package.json'), 'utf8')).version;

mkdirSync(vendor, { recursive: true });

// Minified builds: the unminified sources stay available from the pinned
// upstream release, so inspectability is preserved while the shipped binary
// stays small.
// The legacy build carries what older WebKitGTK releases lack, such as Map.getOrInsertComputed.
const files = [
  ['pdfjs-dist/legacy/build/pdf.min.mjs', 'pdf.mjs'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdf.worker.mjs'],
  ['pdfjs-dist/LICENSE', 'LICENSE.pdfjs'],
];

// The decoders for JPEG 2000 and JBIG2 pictures. Not quickjs-eval: it runs the scripts a PDF carries.
const wasm = ['openjpeg.wasm', 'jbig2.wasm', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2'];

// pdf-lib is shared: every module that writes a PDF needs it, so it lives in
// core/vendor and reaches the modules through scripts/sync-core.mjs.
const shared = [
  ['pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.js'],
  ['pdf-lib/LICENSE.md', 'LICENSE.pdf-lib'],
];

for (const [from, to] of files) {
  copyFileSync(join(nm, from), join(vendor, to));
  console.log(`  ${to}`);
}
mkdirSync(join(vendor, 'wasm'), { recursive: true });
for (const name of wasm) copyFileSync(join(nm, 'pdfjs-dist', 'wasm', name), join(vendor, 'wasm', name));
console.log('  wasm/');

const coreVendor = join(root, '..', '..', 'core', 'vendor');
mkdirSync(coreVendor, { recursive: true });
for (const [from, to] of shared) {
  // The trailing //# sourceMappingURL points at a .map file that is not
  // shipped.
  let source = readFileSync(join(nm, from), 'utf8')
    .replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, '\n');
  // A stream that unpacks without end is refused, as pdf-lib's maintained fork does since CVE-2026-82864.
  if (to === 'pdf-lib.esm.js') {
    const growth = 'for(var n=this.minBufferLength;n<t;)n*=2;';
    if (!source.includes(growth)) throw new Error('pdf-lib changed: the stream limit has nowhere to go');
    source = source.replace(growth, `if(t>268435456)throw new Error("A stream in this PDF unpacks to more than 256 MB");${growth}`);
  }
  writeFileSync(join(coreVendor, to), source);
  console.log(`  core/vendor/${to}`);
}

// Character maps (CJK documents) and the 14 standard PDF fonts.
for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(join(nm, 'pdfjs-dist', dir), join(vendor, dir), { recursive: true });
  console.log(`  ${dir}/`);
}

// Written so the exact upstream releases can be checked against the vendored
// copies by anyone auditing the repository.
writeFileSync(
  join(vendor, 'VERSIONS.txt'),
  [
    'Vendored third-party code. Regenerate with: npm run vendor',
    '',
    `pdfjs-dist  ${pkgVersion('pdfjs-dist')}  (Apache-2.0)`,
    `pdf-lib     ${pkgVersion('pdf-lib')}  (MIT), with a 256 MB limit on one unpacked stream`,
    '',
  ].join('\n'),
);
console.log('  VERSIONS.txt');
