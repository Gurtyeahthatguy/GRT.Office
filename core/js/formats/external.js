/** What a document would fetch from outside or run: found, listed in the opening report, never followed. */

/** The host a reference points at, or the reference itself when it has none. */
function where(target) {
  try {
    const url = new URL(target);
    return url.host || url.protocol.replace(/:$/, '');
  } catch {
    return target.length > 60 ? `${target.slice(0, 57)}...` : target;
  }
}

const isOutside = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\\\') || /^\.\.[/\\]/.test(href);

/** OOXML relationship types, by their last word, and how each is described. */
const RELATIONSHIPS = {
  image: (host) => `A picture linked from ${host}, never fetched`,
  attachedTemplate: (host) => `A template linked from ${host}, never fetched`,
  oleObject: (host) => `An object linked from ${host}, never opened`,
  package: (host) => `An object linked from ${host}, never opened`,
  externalLinkPath: () => 'Data linked from another file, never read',
  subDocument: (host) => `A document linked from ${host}, never fetched`,
  frame: (host) => `A frame linked from ${host}, never fetched`,
  video: (host) => `A video linked from ${host}, never fetched`,
  audio: (host) => `A sound linked from ${host}, never fetched`,
  media: (host) => `Media linked from ${host}, never fetched`,
};

/** Fields that fetch or run something when Word updates them. */
const FIELD = /\b(INCLUDEPICTURE|INCLUDETEXT|DDEAUTO|DDE|LINK|IMPORT)\b/;

/** ODF elements whose link is fetched rather than followed by a click. */
const ODF_LINKED = /<(draw:image|draw:object|draw:object-ole|draw:plugin|draw:floating-frame|draw:fill-image|style:background-image|text:section-source|table:table-source|table:cell-range-source)\b[^>]*?\bxlink:href="([^"]*)"/g;

function scanRelationships(text, losses) {
  for (const [element] of text.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!/\bTargetMode="External"/.test(element)) continue;
    const type = /\bType="([^"]*)"/.exec(element)?.[1] ?? '';
    const target = /\bTarget="([^"]*)"/.exec(element)?.[1] ?? '';
    const kind = type.split('/').pop();
    if (kind === 'hyperlink') continue;
    const describe = RELATIONSHIPS[kind] ?? ((host) => `A reference to ${host} the file would follow, never followed`);
    losses.add(describe(where(target)));
  }
}

function scanWordFields(text, losses) {
  for (const [, instruction] of text.matchAll(/<w:instrText\b[^>]*>([^<]*)</g)) {
    const field = FIELD.exec(instruction);
    if (field) losses.add(`A ${field[1]} field, which fetches from outside or runs a program, never updated`);
  }
  for (const [, instruction] of text.matchAll(/<w:fldSimple\b[^>]*\bw:instr="([^"]*)"/g)) {
    const field = FIELD.exec(instruction);
    if (field) losses.add(`A ${field[1]} field, which fetches from outside or runs a program, never updated`);
  }
}

function scanOdf(text, losses) {
  for (const [, element, href] of text.matchAll(ODF_LINKED)) {
    if (!isOutside(href)) continue;
    const what = element === 'draw:image' || element === 'draw:fill-image' || element === 'style:background-image' ? 'A picture'
      : element.startsWith('table:') ? 'Data'
        : element === 'text:section-source' ? 'A section'
          : 'An object';
    losses.add(`${what} linked from ${where(href)}, never fetched`);
  }
  if (/<(office:dde-source|text:dde-connection-decl|table:dde-link)\b/.test(text)) {
    losses.add('A DDE link to another program, never run');
  }
  if (/<office:script\b/.test(text)) losses.add('Macros, never run and not kept');
  if (/<script:event-listener\b/.test(text)) losses.add('Actions set to run on events, never run');
}

/** Records in `losses` what `source`, a package or a flat ODF text, would fetch from outside or run. */
export function declareExternal(source, losses) {
  if (typeof source === 'string') {
    scanOdf(source, losses);
    return;
  }
  if (!source?.names) return;
  const names = source.names;
  if (names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name) || /^(Basic|Scripts)\//.test(name))) {
    losses.add('Macros, never run and not kept');
  }
  if (names.some((name) => /\/activeX\//i.test(name))) losses.add('ActiveX controls, never run and not kept');
  if (names.some((name) => /^xl\/externalLinks\//i.test(name))) losses.add('Data linked from another workbook, never read');
  if (names.some((name) => /^xl\/connections\.xml$/i.test(name))) losses.add('A connection to outside data, never opened');
  for (const name of names) {
    if (/\.rels$/i.test(name)) scanRelationships(source.text(name) ?? '', losses);
    else if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(name)) scanWordFields(source.text(name) ?? '', losses);
    else if (/^(content|styles)\.xml$/.test(name)) scanOdf(source.text(name) ?? '', losses);
  }
}
