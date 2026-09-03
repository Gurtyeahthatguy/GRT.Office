/** Element identifiers. */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * @param {string} prefix 'n' for nodes, 'e' for edges
 * @param {number} [length=10]
 */
export function makeId(prefix, length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let id = '';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return `${prefix}${id}`;
}
