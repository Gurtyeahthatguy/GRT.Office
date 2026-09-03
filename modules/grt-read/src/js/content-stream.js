/** Tokeniser for PDF page content streams. */

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWhite = (b) => WHITESPACE.has(b);
const isDelimiter = (b) => DELIMITERS.has(b);
const isRegular = (b) => !isWhite(b) && !isDelimiter(b);

/**
 * Splits a content stream into tokens.
 * @param {Uint8Array} bytes
 * @returns {{type: string, raw: string, value: *}[]}
 *   type is one of: number, name, string, array-open, array-close,
 */
export function tokenize(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const tokens = [];
  let i = 0;

  const push = (type, start, value) =>
    tokens.push({ type, raw: text.slice(start, i), value });

  while (i < text.length) {
    const code = text.charCodeAt(i);

    if (isWhite(code)) { i += 1; continue; }

    const start = i;

    // Comments run to the end of the line and carry no meaning.
    if (code === 0x25) {
      while (i < text.length && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d) i += 1;
      push('comment', start, null);
      continue;
    }

    // Literal string: parentheses nest, and a backslash escapes the next
    // byte.
    if (code === 0x28) {
      i += 1;
      let depth = 1;
      const chars = [];
      while (i < text.length && depth > 0) {
        const c = text.charCodeAt(i);
        if (c === 0x5c) {
          chars.push(text[i], text[i + 1]);
          i += 2;
          continue;
        }
        if (c === 0x28) depth += 1;
        if (c === 0x29) { depth -= 1; if (depth === 0) { i += 1; break; } }
        chars.push(text[i]);
        i += 1;
      }
      push('string', start, decodeLiteral(chars.join('')));
      continue;
    }

    // Hex string, or a dictionary opener.
    if (code === 0x3c) {
      if (text[i + 1] === '<') {
        i += 2;
        push('dict-open', start, null);
        continue;
      }
      i += 1;
      const from = i;
      while (i < text.length && text[i] !== '>') i += 1;
      const digits = text.slice(from, i).replace(/\s+/g, '');
      i += 1;
      push('string', start, decodeHex(digits));
      continue;
    }

    if (code === 0x3e && text[i + 1] === '>') {
      i += 2;
      push('dict-close', start, null);
      continue;
    }

    if (code === 0x5b) { i += 1; push('array-open', start, null); continue; }
    if (code === 0x5d) { i += 1; push('array-close', start, null); continue; }

    if (code === 0x2f) {
      i += 1;
      while (i < text.length && isRegular(text.charCodeAt(i))) i += 1;
      push('name', start, text.slice(start + 1, i));
      continue;
    }

    // Numbers, including the forms PDF allows that JSON does not: ".5", "4.".
    if ((code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e) {
      i += 1;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d || c === 0x2b) i += 1;
        else break;
      }
      push('number', start, parseFloat(text.slice(start, i)) || 0);
      continue;
    }

    // Anything else regular is an operator.
    if (isRegular(code)) {
      while (i < text.length && isRegular(text.charCodeAt(i))) i += 1;
      const name = text.slice(start, i);

      // An inline image's data is raw bytes between ID and EI.
      if (name === 'BI') {
        const end = findInlineImageEnd(text, i);
        i = end;
        push('inline-image', start, null);
        continue;
      }

      push('operator', start, name);
      continue;
    }

    // Unknown byte: keep it rather than drop it.
    i += 1;
    push('operator', start, text.slice(start, i));
  }

  return tokens;
}

/** Finds the EI that closes an inline image. */
function findInlineImageEnd(text, from) {
  const idIndex = text.indexOf('ID', from);
  if (idIndex === -1) return text.length;

  let i = idIndex + 3;   // ID plus the single whitespace byte that follows.
  while (i < text.length - 1) {
    if (text[i] === 'E' && text[i + 1] === 'I'
      && isWhite(text.charCodeAt(i - 1))
      && (i + 2 >= text.length || isWhite(text.charCodeAt(i + 2)))) {
      return i + 2;
    }
    i += 1;
  }
  return text.length;
}

function decodeLiteral(body) {
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out.push(body[i]); continue; }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n': out.push('\n'); break;
      case 'r': out.push('\r'); break;
      case 't': out.push('\t'); break;
      case 'b': out.push('\b'); break;
      case 'f': out.push('\f'); break;
      case '(': out.push('('); break;
      case ')': out.push(')'); break;
      case '\\': out.push('\\'); break;
      default:
        if (next >= '0' && next <= '7') {
          let digits = next;
          while (digits.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
            digits += body[i + 1];
            i += 1;
          }
          out.push(String.fromCharCode(parseInt(digits, 8)));
        } else {
          out.push(next ?? '');
        }
    }
  }
  return out.join('');
}

function decodeHex(digits) {
  const even = digits.length % 2 === 0 ? digits : `${digits}0`;
  let out = '';
  for (let i = 0; i < even.length; i += 2) {
    out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
  }
  return out;
}

/** Puts tokens back together into stream bytes. */
export function serialize(tokens) {
  const parts = [];
  for (const token of tokens) {
    if (token.type === 'comment') continue;
    parts.push(token.raw);
  }
  const text = parts.join('\n');
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
