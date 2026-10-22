/** LibreOffice as the oracle, for tests on a development machine; nothing here ships. */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examples = join(repo, 'core', 'grt-app', 'target', 'debug', 'examples');

const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

/** Whether LibreOffice and the package tools are here. */
export function oracleAvailable() {
  if (!has('soffice') || !has('cargo')) return false;
  if (!existsSync(join(examples, 'write-block'))) {
    const built = spawnSync('cargo', ['build', '--quiet', '--examples'], { cwd: join(repo, 'core', 'grt-app') });
    if (built.status !== 0) return false;
  }
  return true;
}

const base = process.env.GRT_SCRATCH ?? join(homedir(), '.cache', 'grt-oracle');

export function scratch() {
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'run-'));
}

/** Removes a scratch folder, unless GRT_KEEP asks for it to be looked at. */
export function cleanup(dir) {
  if (process.env.GRT_KEEP) return;
  if (dir && dir.startsWith(base)) rmSync(dir, { recursive: true, force: true });
}

/** Writes a block through the same Rust code the programs use. */
export function writeBlock(block, target) {
  const file = `${target}.block`;
  writeFileSync(file, block);
  execFileSync(join(examples, 'write-block'), [file, target]);
}

export function readBlock(packageFile) {
  const file = `${packageFile}.block`;
  execFileSync(join(examples, 'read-block'), [packageFile, file]);
  return readFileSync(file);
}

const profile = join(tmpdir(), `grt-oracle-profile-${process.pid}`);

/**
 * Converts with LibreOffice and returns the path written.
 * @param {string} source
 * @param {string} filter such as "odt", "docx:MS Word 2007 XML" or "pdf"
 */
export function convert(source, filter, outDir = null) {
  const out = outDir ?? scratch();
  mkdirSync(out, { recursive: true });
  const result = spawnSync('soffice', [
    `-env:UserInstallation=file://${profile}`,
    '--headless', '--norestore', '--convert-to', filter, '--outdir', out, source,
  ], { encoding: 'utf8', timeout: 120000 });
  const extension = filter.split(':')[0];
  const wanted = `${basename(source).replace(/\.[^.]+$/, '')}.${extension}`;
  const found = readdirSync(out).find((name) => name === wanted);
  if (!found) throw new Error(`LibreOffice did not convert ${source}: ${result.stderr || result.stdout}`);
  return join(out, found);
}

/** The text of a PDF, page by page, if pdftotext is here. */
export function pdfPages(file) {
  if (!has('pdftotext')) return null;
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).split('\f');
}

/** Every word of a PDF with its page and box, if pdftotext is here. */
export function pdfWords(file) {
  if (!has('pdftotext')) return null;
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  const words = [];
  let page = 0;
  let width = 0;
  for (const line of xml.split('\n')) {
    const pageMatch = /<page width="([\d.]+)"/.exec(line);
    if (pageMatch) {
      page += 1;
      width = Number(pageMatch[1]);
      continue;
    }
    const word = /xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</.exec(line);
    if (word) {
      words.push({
        page, width, text: word[5], x0: Number(word[1]), y0: Number(word[2]), x1: Number(word[3]), y1: Number(word[4]),
      });
    }
  }
  return words;
}
