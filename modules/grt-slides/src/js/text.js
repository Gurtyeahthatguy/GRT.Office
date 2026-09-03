/** Editing rich text inside a box. */

/**
 * Turns runs into the markup a contenteditable box edits.
 * @param {{text: string, bold?: boolean, italic?: boolean, underline?: boolean}[]} runs
 */
export function runsToHtml(runs) {
  const escape = (value) => String(value ?? '')
    .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  const html = (runs ?? []).map((run) => {
    let piece = escape(run.text).replace(/\n/g, '<br>');
    if (run.bold) piece = `<b>${piece}</b>`;
    if (run.italic) piece = `<i>${piece}</i>`;
    if (run.underline) piece = `<u>${piece}</u>`;
    return piece;
  }).join('');

  return html || '<br>';
}

/**
 * Reads an edited box back into runs.
 * @param {HTMLElement} element
 * @returns {{text: string, bold?: boolean, italic?: boolean, underline?: boolean}[]}
 */
export function htmlToRuns(element) {
  const runs = [];

  const walk = (node, format) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue !== '') push(runs, node.nodeValue, format);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.nodeName.toLowerCase();
    if (tag === 'br') {
      push(runs, '\n', format);
      return;
    }

    const next = { ...format };
    if (tag === 'b' || tag === 'strong') next.bold = true;
    if (tag === 'i' || tag === 'em') next.italic = true;
    if (tag === 'u') next.underline = true;

    // A block element inside the box is a paragraph break, which the model
    // represents as a newline rather than as structure.
    const isBlock = tag === 'div' || tag === 'p';
    if (isBlock && runs.length > 0) push(runs, '\n', format);

    for (const child of node.childNodes) walk(child, next);
  };

  for (const child of element.childNodes) walk(child, {});

  return runs.length > 0 ? runs : [{ text: '' }];
}

function push(runs, text, format) {
  const last = runs[runs.length - 1];
  const same = last
    && !!last.bold === !!format.bold
    && !!last.italic === !!format.italic
    && !!last.underline === !!format.underline;

  if (same) {
    last.text += text;
    return;
  }

  runs.push({
    text,
    ...(format.bold ? { bold: true } : {}),
    ...(format.italic ? { italic: true } : {}),
    ...(format.underline ? { underline: true } : {}),
  });
}

/** Applies bold, italic or underline to the current selection. */
export function toggleFormat(command) {
  try {
    document.execCommand(command, false, null);
    return true;
  } catch {
    return false;
  }
}
