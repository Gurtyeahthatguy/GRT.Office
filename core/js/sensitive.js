/**
 * A local finder of what should not leave a document: Italian tax codes, IBANs, card numbers, telephones,
 * emails and number plates. Every candidate is checked, by its control character or sum, where one exists.
 */

export const SENSITIVE_KINDS = {
  taxcode: 'Codici fiscali',
  iban: 'IBAN',
  card: 'Credit cards',
  phone: 'Telephone numbers',
  email: 'Email addresses',
  plate: 'Number plates',
};

const ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];

/** The control letter of an Italian codice fiscale is right. */
export function taxCodeValid(code) {
  const text = code.toUpperCase();
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPR-T][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(text)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    const ch = text[i];
    const value = /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
    sum += i % 2 === 0 ? ODD[value] : value;
  }
  return String.fromCharCode(65 + (sum % 26)) === text[15];
}

/** An IBAN's two check digits are right, by ISO 13616's mod 97. */
export function ibanValid(iban) {
  const text = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(text)) return false;
  const moved = text.slice(4) + text.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

/** A card number passes Luhn's check. */
export function luhnValid(number) {
  const digits = number.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const PATTERNS = {
  taxcode: { re: /(?<![\p{L}\p{N}])[A-Za-z]{6}[0-9LMNPQRSTUVlmnpqrstuv]{2}[A-Za-z][0-9LMNPQRSTUVlmnpqrstuv]{2}[A-Za-z][0-9LMNPQRSTUVlmnpqrstuv]{3}[A-Za-z](?![\p{L}\p{N}])/gu, check: taxCodeValid },
  iban: { re: /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/gu, check: ibanValid },
  card: { re: /(?<![\p{N}])\d(?:[ -]?\d){12,18}(?![\p{N}])/gu, check: luhnValid },
  email: { re: /(?<![\w.+-])[\w.+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+(?![\p{L}\p{N}])/gu },
  phone: { re: /(?<![\p{L}\p{N}+])(?:\+\d{1,3}[ .]?)?(?:\(?0\d{1,4}\)?|3\d{2})[ ./-]?\d{3,4}[ .-]?\d{2,4}(?![\p{L}\p{N}])/gu, check: (t) => t.replace(/\D/g, '').length >= 8 },
  plate: { re: /(?<![\p{L}\p{N}])[A-HJ-NPR-TV-Z]{2} ?\d{3} ?[A-HJ-NPR-TV-Z]{2}(?![\p{L}\p{N}])/gu },
};

/**
 * What a text holds of the kinds asked for, and the words and expressions given, in order and never overlapping.
 * @param {string[]} kinds keys of SENSITIVE_KINDS
 * @param {RegExp[]} extra patterns of the person's own, global
 * @returns {{from: number, to: number, kind: string, text: string}[]}
 */
export function findSensitive(text, kinds = Object.keys(SENSITIVE_KINDS), extra = []) {
  const found = [];
  const source = String(text ?? '').slice(0, 5_000_000);
  // The strictest checks first, so a card number is not taken for a telephone.
  const order = ['taxcode', 'iban', 'card', 'email', 'plate', 'phone'].filter((k) => kinds.includes(k));
  const free = (from, to) => !found.some((f) => from < f.to && f.from < to);
  for (const kind of order) {
    const { re, check } = PATTERNS[kind];
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      if (check && !check(match[0])) continue;
      const from = match.index;
      const to = from + match[0].length;
      if (free(from, to)) found.push({ from, to, kind, text: match[0] });
      if (found.length > 100_000) break;
    }
  }
  for (const re of extra) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      if (match[0] === '') continue;
      const from = match.index;
      const to = from + match[0].length;
      if (free(from, to)) found.push({ from, to, kind: 'own', text: match[0] });
      if (found.length > 100_000) break;
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** What stands in for redacted text in a copy: always the same, so its length tells nothing. */
export const REDACTED = '█████';
