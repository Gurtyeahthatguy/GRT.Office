/** The simple format that is not simple. */

/**
 * Works out how a file is probably punctuated.
 * @returns {{separator: string, decimal: string, confident: boolean,
 */
export function sniff(text) {
  const sample = stripBom(text).split(/\r?\n/).slice(0, 20).filter((line) => line !== '');

  if (sample.length === 0) {
    return { separator: ',', decimal: '.', confident: false, reason: 'The file is empty' };
  }

  const candidates = [',', ';', '\t'];
  const scores = candidates.map((separator) => ({ separator, ...scoreOf(sample, separator) }));

  // Ordered by how consistent the column count is first, and by how many
  // columns that gives second.
  scores.sort((a, b) => b.consistency - a.consistency || b.columns - a.columns);

  const [best, second] = scores;

  if (best.columns <= 1) {
    return {
      separator: ',',
      decimal: '.',
      confident: false,
      reason: 'No separator found — the file may have a single column',
    };
  }

  // A semicolon file is usually a comma-decimal file.
  const decimal = best.separator === ';' ? ',' : '.';

  const clear = best.consistency >= 0.9
    && (best.consistency > second.consistency || best.columns > second.columns);

  const name = (s) => (s === '\t' ? 'tab' : s);

  return {
    separator: best.separator,
    decimal,
    confident: clear,
    reason: clear
      ? `Separator "${name(best.separator)}", ${best.columns} columns, decimal "${decimal}"`
      : `Ambiguous: ${scores.filter((s) => s.columns > 1)
        .map((s) => `${name(s.separator)} gives ${s.columns}`).join(', ')}`,
  };
}

/** How well a separator explains a file. */
function scoreOf(lines, separator) {
  const counts = new Map();

  for (const line of lines) {
    const fields = countOutsideQuotes(line, separator) + 1;
    counts.set(fields, (counts.get(fields) ?? 0) + 1);
  }

  let columns = 1;
  let best = 0;
  for (const [fields, howMany] of counts) {
    if (howMany > best || (howMany === best && fields > columns)) {
      columns = fields;
      best = howMany;
    }
  }

  return { columns, consistency: best / lines.length };
}

const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function countOutsideQuotes(text, character) {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (!quoted && c === character) count += 1;
  }
  return count;
}

/** Reads a CSV file into rows of cells. */
export function parseCsv(text, { separator = ',' } = {}) {
  const source = stripBom(String(text ?? ''));
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < source.length) {
    const c = source[i];

    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }

    if (c === '"' && field === '') { quoted = true; i += 1; continue; }
    if (c === separator) { endField(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { endRow(); i += 1; continue; }

    field += c;
    i += 1;
  }

  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Turns a text field into a number when it plainly is one. */
export function coerce(text, { decimal = '.' } = {}) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;

  const normalised = decimal === ','
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed.replace(/,/g, '');

  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(normalised)) {
    const parsed = Number(normalised);
    if (Number.isFinite(parsed)) return parsed;
  }

  return trimmed;
}

/** Writes rows out as CSV. */
export function toCsv(rows, { separator = ',' } = {}) {
  return `${rows.map((row) => row.map((field) => escapeField(field, separator)).join(separator))
    .join('\r\n')}\r\n`;
}

function escapeField(value, separator) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  if (text.includes('"') || text.includes(separator) || /[\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
