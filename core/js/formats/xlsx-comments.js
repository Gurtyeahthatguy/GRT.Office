/** Comments on cells in .xlsx: the comments part, and the VML drawing Excel needs to show them. */

import { NS, kids, kid, tag, xmlDocument } from '../xml.js';
import { relationships, readPart } from './ooxml.js';

const S = NS.s;
const NOTE_LIMIT = 100_000;
const MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
export const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
export const REL_VML = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing';
export const COMMENTS_TYPE = `${MAIN}.comments+xml`;
export const VML_TYPE = 'application/vnd.openxmlformats-officedocument.vmlDrawing';

const columnIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const columnName = (index) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

/** Puts the comments of a sheet's comments part on its cells, as text; who wrote them is not kept. */
export function readXlsxComments(pkg, sheetPart, cells, losses) {
  for (const rel of relationships(pkg, sheetPart).values()) {
    if (!rel.type.endsWith('/comments') || rel.external) continue;
    const root = readPart(pkg, rel.target, 'the comments')?.documentElement;
    if (!root) continue;
    if (kids(kid(root, S, 'authors'), S, 'author').some((a) => a.textContent.trim() !== '')) losses.add('Names and dates on comments, left out');
    for (const comment of kids(kid(root, S, 'commentList'), S, 'comment')) {
      const ref = /^([A-Z]{1,3})(\d{1,7})$/.exec(comment.getAttribute('ref') ?? '');
      if (!ref) continue;
      const row = Number(ref[2]) - 1;
      const col = columnIndex(ref[1]);
      if (row < 0 || row >= 1_048_576 || col < 0 || col >= 16_384) continue;
      const text = [...(kid(comment, S, 'text')?.getElementsByTagNameNS(S, 't') ?? [])].map((t) => t.textContent).join('').slice(0, NOTE_LIMIT);
      if (text.trim() === '') continue;
      const at = `${row},${col}`;
      cells[at] = { ...(cells[at] ?? {}), n: text };
    }
  }
}

/** The cells of a sheet that carry comments, row by row. */
export function notesOf(sheet) {
  return Object.entries(sheet.cells ?? {})
    .filter(([, cell]) => typeof cell?.n === 'string' && cell.n !== '')
    .map(([at, cell]) => {
      const [row, col] = at.split(',').map(Number);
      return { row, col, text: cell.n, shown: !!cell.ns };
    })
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

/** The comments part of a sheet, its author left empty. */
export function commentsXml(notes) {
  return xmlDocument(tag('comments', { xmlns: S },
    tag('authors', {}, tag('author', {}, '')),
    tag('commentList', {}, notes.map((note) => tag('comment', { ref: `${columnName(note.col)}${note.row + 1}`, authorId: '0' },
      tag('text', {}, tag('r', {}, tag('t', { 'xml:space': 'preserve' }, note.text))))))));
}

/** The VML drawing that gives each comment its box, as Excel and LibreOffice write it. */
export function vmlXml(notes, number = 1) {
  const shapes = notes.map((note, i) => `<v:shape id="_x0000_s${number * 1024 + 1 + i}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${i + 1};visibility:${note.shown ? 'visible' : 'hidden'}" fillcolor="#ffffe1" o:insetmode="auto">
<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/>
<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>
<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill><x:Row>${note.row}</x:Row><x:Column>${note.col}</x:Column>${note.shown ? '<x:Visible/>' : ''}</x:ClientData>
</v:shape>`).join('\n');
  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${number}"/></o:shapelayout>
<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>
${shapes}
</xml>`;
}
