/** The status bar along the bottom, with what LibreOffice shows there: where you are, the words, the style, the language, the zoom. */

/**
 * @param {HTMLElement} element
 * @param {{key: string, title: string, text: () => string, run?: Function, grow?: boolean}[]} fields
 */
export function createStatusBar(element, fields) {
  element.classList.add('statusbar');
  element.setAttribute('role', 'status');
  const parts = fields.map((field) => {
    const node = document.createElement(field.run ? 'button' : 'span');
    node.className = `status-field${field.grow ? ' grow' : ''}`;
    node.dataset.status = field.key;
    node.title = field.title;
    if (field.run) {
      node.type = 'button';
      node.addEventListener('click', () => field.run());
    }
    element.append(node);
    return { field, node };
  });
  function refresh() {
    for (const { field, node } of parts) {
      const text = field.text();
      if (node.textContent !== text) node.textContent = text;
      node.hidden = text === '';
    }
  }
  refresh();
  return { refresh };
}
