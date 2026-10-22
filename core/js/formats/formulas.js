/** Formulas between Grid's syntax (Excel's A1) and the files': OpenFormula in ODF, Excel's own in OOXML. */

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
const COLUMN_ONLY = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w(])/;
const ROW_ONLY = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\w(.])/;

/** Functions Excel writes with `_xlfn.`. */
const FUTURE = new Set([
  'AGGREGATE', 'ARABIC', 'BASE', 'BINOM.DIST', 'BINOM.INV', 'BITAND', 'BITOR', 'BITXOR', 'CEILING.MATH',
  'CEILING.PRECISE', 'CHISQ.DIST', 'CHISQ.INV', 'CONCAT', 'CONFIDENCE.NORM', 'COT', 'COVARIANCE.P',
  'COVARIANCE.S', 'CSC', 'DAYS', 'DECIMAL', 'EXPON.DIST', 'F.DIST', 'F.INV', 'FILTER', 'FLOOR.MATH',
  'FLOOR.PRECISE', 'FORECAST.LINEAR', 'FORMULATEXT', 'GAMMA', 'GAMMA.DIST', 'GAUSS', 'IFNA', 'IFS',
  'ISFORMULA', 'ISOWEEKNUM', 'LET', 'LOGNORM.DIST', 'MAXIFS', 'MINIFS', 'MODE.MULT', 'MODE.SNGL',
  'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'NUMBERVALUE', 'PERCENTILE.EXC',
  'PERCENTILE.INC', 'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'POISSON.DIST', 'QUARTILE.EXC',
  'QUARTILE.INC', 'RANDARRAY', 'RANK.AVG', 'RANK.EQ', 'SEC', 'SEQUENCE', 'SHEET', 'SHEETS', 'SINGLE',
  'SORT', 'SORTBY', 'STDEV.P', 'STDEV.S', 'SWITCH', 'T.DIST', 'T.INV', 'TEXTJOIN', 'UNICHAR',
  'UNICODE', 'UNIQUE', 'VAR.P', 'VAR.S', 'WEIBULL.DIST', 'XLOOKUP', 'XMATCH', 'XOR', 'Z.TEST',
]);

/** Of those, the ones Excel also marks as worksheet functions. */
const WORKSHEET = new Set(['FILTER', 'SORT']);

/** Functions LibreOffice names under Microsoft's namespace in OpenFormula. */
const MICROSOFT = new Set(['CONCAT', 'IFS', 'MAXIFS', 'MINIFS', 'SWITCH', 'TEXTJOIN', 'XLOOKUP',
  'XMATCH', 'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE', 'RANDARRAY', 'LET', 'FORECAST.LINEAR']);

/** A sheet name as a reference writes it: quoted when it has to be. */
export function quoteSheet(name) {
  return /^[A-Za-z_][\w.]*$/.test(name) && !CELL.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * Splits Excel-syntax formula text into the pieces translation cares about:
 * strings, references, function names and the rest, character by character.
 */
function scanExcel(text, visit) {
  let out = '';
  let i = 0;
  let braces = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '{') braces += 1;
    if (c === '}') braces -= 1;
    const rest = text.slice(i);
    const word = /^(?:'(?:[^']|'')+'|[A-Za-z_$][\w.$]*)/.exec(rest);
    if (word && !/[\w.$]/.test(text[i - 1] ?? '')) {
      const result = visit({ kind: 'word', text: rest, at: i, braces, word: word[0] });
      if (result) {
        out += result.out;
        i += result.length;
        continue;
      }
    }
    const digits = /^\$?\d{1,7}:\$?\d{1,7}/.exec(rest);
    if (digits && !/[\w.]/.test(text[i - 1] ?? '')) {
      const result = visit({ kind: 'rows', text: rest, at: i, braces });
      if (result) {
        out += result.out;
        i += result.length;
        continue;
      }
    }
    const symbol = visit({ kind: 'char', char: c, braces });
    out += symbol ?? c;
    i += 1;
  }
  return out;
}

/** A reference at the start of `text`: its sheet, its two corners, and its length; null if none. */
function readReference(text) {
  let sheet = null;
  let at = 0;
  const quoted = /^'((?:[^']|'')+)'!/.exec(text);
  const plain = /^([A-Za-z_][\w.]*)!/.exec(text);
  if (quoted) {
    sheet = quoted[1].replace(/''/g, "'");
    at = quoted[0].length;
  } else if (plain) {
    sheet = plain[1];
    at = plain[0].length;
  }
  const rest = text.slice(at);
  const column = COLUMN_ONLY.exec(rest);
  if (column) {
    return { sheet, from: `${column[1]}${column[2]}`, to: `${column[3]}${column[4]}`, length: at + column[0].length, whole: 'columns' };
  }
  const row = ROW_ONLY.exec(rest);
  if (row) {
    return { sheet, from: `${row[1]}${row[2]}`, to: `${row[3]}${row[4]}`, length: at + row[0].length, whole: 'rows' };
  }
  const first = CELL.exec(rest);
  if (!first) return null;
  let length = first[0].length;
  if (/[\w(.]/.test(rest[length] ?? '')) return null;
  let to = null;
  if (rest[length] === ':') {
    const second = CELL.exec(rest.slice(length + 1));
    if (second && !/[\w(.]/.test(rest[length + 1 + second[0].length] ?? '')) {
      to = second[0];
      length += 1 + second[0].length;
    }
  }
  return { sheet, from: first[0], to, length: at + length };
}

// OpenFormula to Grid

/**
 * `of:=SUM([.A1:.B2];[$Sheet2.C3])` to `=SUM(A1:B2,Sheet2!C3)`.
 * @returns {{formula: string, problems: string[]}}
 */
export function fromOpenFormula(text) {
  const problems = [];
  const source = String(text);
  if (/^msoxl:=/.test(source)) return { formula: `=${source.slice(7)}`, problems };
  const body = source.replace(/^(of|oooc):=?/, '').replace(/^=/, '');

  let out = '';
  let braces = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"') {
      let j = i + 1;
      while (j < body.length && !(body[j] === '"' && body[j + 1] !== '"')) j += body[j] === '"' ? 2 : 1;
      out += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let quote = false;
      while (j < body.length && (quote || body[j] !== ']')) {
        if (body[j] === "'") quote = !quote;
        j += 1;
      }
      out += odfReference(body.slice(i + 1, j), problems);
      i = j;
      continue;
    }
    if (c === '{') braces += 1;
    if (c === '}') braces -= 1;
    if (c === ';') out += ',';
    else if (c === '|' && braces > 0) out += ';';
    else if (c === '~') {
      problems.push('Unions of ranges (~)');
      out += ',';
    } else if (c === '!') {
      problems.push('Intersections of ranges (!)');
      out += ' ';
    } else out += c;
  }
  // Microsoft's own functions, by their plain names.
  out = out.replace(/\bCOM\.MICROSOFT\.([A-Z][A-Z0-9.]*)\s*\(/gi, '$1(');
  return { formula: `=${out}`, problems };
}

/** One bracketed ODF reference, in Grid's syntax. */
function odfReference(inner, problems) {
  if (/^#REF!/i.test(inner) || inner.includes('#REF!')) return '#REF!';
  if (/^'[^']*'#|^[a-z]+:\/\//i.test(inner)) {
    problems.push('References to other files');
    return '#REF!';
  }
  const parts = splitOutsideQuotes(inner, ':');
  let sheet = null;
  const cells = parts.map((part) => {
    const match = /^\$?(?:'((?:[^']|'')*)'|([^.']*))?\.(.*)$/.exec(part);
    if (!match) return part;
    const named = match[1] !== undefined ? match[1].replace(/''/g, "'") : (match[2] || null);
    if (named) {
      if (sheet && named !== sheet) problems.push('References across several sheets');
      sheet ??= named;
    }
    return match[3];
  });
  const prefix = sheet ? `${quoteSheet(sheet)}!` : '';
  return `${prefix}${cells.join(':')}`;
}

function splitOutsideQuotes(text, separator) {
  const parts = [];
  let quote = false;
  let current = '';
  for (const c of text) {
    if (c === "'") quote = !quote;
    if (c === separator && !quote) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  return parts;
}

// Grid to OpenFormula

/** `=SUM(A1:B2,Sheet2!C3)` to `of:=SUM([.A1:.B2];[$Sheet2.C3])`. */
export function toOpenFormula(formula) {
  const body = String(formula).replace(/^=/, '');
  const out = scanExcel(body, (piece) => {
    if (piece.kind === 'word' || piece.kind === 'rows') {
      const reference = readReference(piece.text);
      if (reference) {
        const sheet = reference.sheet ? `$${quoteSheet(reference.sheet)}` : '';
        const from = `${sheet}.${reference.from}`;
        const text = reference.to ? `[${from}:.${reference.to}]` : `[${from}]`;
        return { out: text, length: reference.length };
      }
      if (piece.kind === 'word') {
        const name = /^[A-Za-z_][\w.]*/.exec(piece.text)?.[0];
        if (name && piece.text[name.length] === '(' && MICROSOFT.has(name.toUpperCase())) {
          return { out: `COM.MICROSOFT.${name.toUpperCase()}`, length: name.length };
        }
        if (name) return { out: name, length: name.length };
      }
      return null;
    }
    // Columns of an array constant are split by `;` there, and rows by `|`.
    if (piece.char === ',') return ';';
    if (piece.char === ';') return piece.braces > 0 ? '|' : ';';
    return null;
  });
  return `of:=${out}`;
}

// Excel's own

/** `_xlfn.CONCAT(A1,B1)` to `=CONCAT(A1,B1)`. */
export function fromExcelFormula(text) {
  return `=${String(text).replace(/\b(?:_xl(?:fn|ws)\.)+(?=[A-Za-z])/g, '')}`;
}

/** `=CONCAT(A1;B1)` to `_xlfn.CONCAT(A1,B1)`, as Excel stores it. */
export function toExcelFormula(formula) {
  const body = String(formula).replace(/^=/, '');
  return scanExcel(body, (piece) => {
    if (piece.kind === 'word') {
      const reference = readReference(piece.text);
      if (reference) return { out: piece.text.slice(0, reference.length), length: reference.length };
      const name = /^[A-Za-z_][\w.]*/.exec(piece.text)?.[0];
      if (name && piece.text[name.length] === '(' && FUTURE.has(name.toUpperCase())) {
        const prefix = WORKSHEET.has(name.toUpperCase()) ? '_xlfn._xlws.' : '_xlfn.';
        return { out: `${prefix}${name.toUpperCase()}`, length: name.length };
      }
      if (name) return { out: name, length: name.length };
      return null;
    }
    if (piece.kind === 'rows') return null;
    if (piece.char === ';') return ',';
    return null;
  });
}

/**
 * A formula moved by some rows and columns, as Excel's shared formulas are:
 * relative parts move, `$` parts stay.
 */
export function shiftFormula(formula, rows, cols) {
  const body = String(formula).replace(/^=/, '');
  const moveCell = (cell) => {
    const match = CELL.exec(cell);
    if (!match) return cell;
    const [, absCol, letters, absRow, digits] = match;
    const col = absCol ? letters : columnLetters(columnIndex(letters) + cols);
    const row = absRow ? digits : String(Number(digits) + rows);
    if (!col || Number(row) < 1) return '#REF!';
    return `${absCol}${col}${absRow}${row}`;
  };
  const moveColumn = (part) => {
    const match = /^(\$?)([A-Za-z]{1,3})$/.exec(part);
    return match[1] ? part : columnLetters(columnIndex(match[2]) + cols) ?? '#REF!';
  };
  const moveRow = (part) => {
    const match = /^(\$?)(\d+)$/.exec(part);
    return match[1] ? part : String(Number(match[2]) + rows);
  };
  const moved = scanExcel(body, (piece) => {
    if (piece.kind !== 'word' && piece.kind !== 'rows') return null;
    const reference = readReference(piece.text);
    if (!reference) {
      if (piece.kind === 'word') {
        const name = /^[A-Za-z_][\w.]*/.exec(piece.text)?.[0];
        return name ? { out: name, length: name.length } : null;
      }
      return null;
    }
    const prefix = reference.sheet ? `${quoteSheet(reference.sheet)}!` : '';
    let text;
    if (reference.whole === 'columns') text = `${moveColumn(reference.from)}:${moveColumn(reference.to)}`;
    else if (reference.whole === 'rows') text = `${moveRow(reference.from)}:${moveRow(reference.to)}`;
    else text = reference.to ? `${moveCell(reference.from)}:${moveCell(reference.to)}` : moveCell(reference.from);
    return { out: `${prefix}${text}`, length: reference.length };
  });
  return `=${moved}`;
}

export function columnIndex(letters) {
  let index = 0;
  for (const c of letters.toUpperCase()) index = index * 26 + (c.charCodeAt(0) - 64);
  return index - 1;
}

export function columnLetters(index) {
  if (index < 0 || index > 16383) return null;
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `B3` as a zero-based row and column. */
export function parseCell(address) {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(address);
  if (!match) return null;
  return { row: Number(match[2]) - 1, col: columnIndex(match[1]) };
}
