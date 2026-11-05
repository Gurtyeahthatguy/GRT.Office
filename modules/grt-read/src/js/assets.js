/** Where the vendored PDF.js finds its files. */

/** A folder beside this file, ending in a slash as PDF.js insists, even where a bundler drops it. */
export const folderUrl = (path) => {
  const href = new URL(path, import.meta.url).href;
  return href.endsWith('/') ? href : `${href}/`;
};
