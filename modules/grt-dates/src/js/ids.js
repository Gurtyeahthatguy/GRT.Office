/** Identifiers that identify nothing. */

/** A random identifier for a calendar entry. */
export function newUid() {
  return random();
}

/** A random identifier for anything internal that needs one. */
export function newId(prefix = 'x') {
  return `${prefix}-${random().slice(0, 12)}`;
}

function random() {
  const source = globalThis.crypto;

  if (source && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }

  if (source && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // No platform randomness at all.
  throw new Error('No cryptographic randomness available');
}
