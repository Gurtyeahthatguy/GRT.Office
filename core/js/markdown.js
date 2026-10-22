/** Markdown through markdown-it, which installs itself as a global when imported. */

import * as vendored from '../../vendor/markdown-it.min.js';

const markdownit = globalThis.markdownit ?? vendored.default;

/** A parser with the CommonMark rules and nothing that reaches the network. */
export function markdownParser(options = {}) {
  return markdownit({ html: false, linkify: false, typographer: false, ...options });
}
