/** Cut, Copy and Paste from buttons and menus: the first two as the keys do, Paste through the program, which reads the clipboard only when asked. */

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

/** Cut or copy what is chosen, through the same handlers Ctrl+X and Ctrl+C reach. */
export function cutOrCopy(kind) {
  document.execCommand(kind);
}

/** Pastes into whatever has the focus, as Ctrl+V would: the clipboard's HTML and text handed to the page's own paste. */
export async function paste(target = document.activeElement ?? document.body) {
  const { text, html } = await invoke('clipboard_read');
  if (!text && !html) return false;
  const data = new DataTransfer();
  if (html) data.setData('text/html', html);
  if (text) data.setData('text/plain', text);
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  return true;
}

/** The three items, as Edit menus list them; the keys are shown, and left to the program as before. */
export function clipboardItems({ beforePaste = () => {} } = {}) {
  return [
    { label: 'Cut', keys: 'Ctrl+X', run: () => cutOrCopy('cut') },
    { label: 'Copy', keys: 'Ctrl+C', run: () => cutOrCopy('copy') },
    { label: 'Paste', keys: 'Ctrl+V', run: async () => { const target = beforePaste() ?? document.activeElement; await paste(target ?? undefined); } },
  ];
}
