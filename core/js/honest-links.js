/**
 * Honest links: the real destination is shown before anything is done with it, a warning comes when the words
 * say another place, and file:, javascript: and their kind are refused. GRT never opens the web itself.
 */

import { showChoice, escapeHtml } from './panel.js';

/** Schemes that run code, read the disk or hide what they carry. */
const REFUSED = new Set(['file', 'javascript', 'vbscript', 'data', 'blob', 'jar', 'filesystem', 'view-source']);
const WEB = new Set(['http', 'https']);
const KNOWN = new Set(['http', 'https', 'mailto', 'tel', 'ftp', 'sftp', 'news', 'irc', 'xmpp', 'geo']);

/** Browsers skip tabs, line breaks and leading controls in an address, so "java\tscript:" is javascript:. */
const tidy = (href) => String(href ?? '').replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '');

/** The host a piece of text names, when it reads like an address: example.com, www.example.com/x, https://… */
function hostIn(text) {
  const found = /(?:[a-z][a-z0-9+.-]*:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63})(?=[/:?#\s]|$)/iu.exec(String(text ?? '').trim());
  if (!found) return null;
  try {
    return new URL(`http://${found[1]}`).hostname;
  } catch {
    return null;
  }
}

const bare = (host) => String(host ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

/**
 * What a link really is.
 * @returns {{href: string, scheme: ?string, host: ?string, internal: boolean, refused: ?string, warnings: string[]}}
 */
export function examineLink(href, text = '') {
  const raw = String(href ?? '').trim();
  const clean = tidy(raw);
  const warnings = [];
  if (clean.startsWith('#')) return { href: clean, scheme: null, host: null, internal: true, refused: null, warnings };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean)?.[1]?.toLowerCase() ?? null;
  if (clean !== raw.replace(/^\s+|\s+$/g, '')) warnings.push('The address has hidden characters in it, taken out here.');
  if (!scheme) return { href: clean, scheme: null, host: null, internal: false, refused: 'This is not a full address, so there is nowhere sure to go.', warnings };
  if (REFUSED.has(scheme)) return { href: clean, scheme, host: null, internal: false, refused: `GRT never follows ${scheme}: links: they can run code or read your files.`, warnings };
  if (!KNOWN.has(scheme)) warnings.push(`A ${scheme}: link starts another program, not a web page.`);
  let host = null;
  if (WEB.has(scheme) || scheme === 'ftp') {
    let url;
    try {
      url = new URL(clean);
    } catch {
      return { href: clean, scheme, host: null, internal: false, refused: 'The address is not well formed.', warnings };
    }
    host = url.hostname;
    if (url.username || url.password) warnings.push(`The part before @ is not where it goes: the address leads to ${host}.`);
    if (/(^|\.)xn--/i.test(host)) warnings.push(`The name of the site uses letters of other alphabets, which can look like others: ${host}.`);
    if (/^\d{1,3}(\.\d{1,3}){3}$|^\[/.test(host)) warnings.push('The address is a bare number, not a site name.');
    if (scheme === 'http') warnings.push('The address is not encrypted (http, not https).');
  }
  if (scheme === 'mailto') host = clean.slice(7).split('?')[0].split('@')[1] ?? null;
  const said = hostIn(text);
  if (said && host && bare(said) !== bare(host) && !bare(host).endsWith(`.${bare(said)}`)) {
    warnings.unshift(`The text says ${said}, but the link goes to ${host}.`);
  } else if (said && !host) {
    warnings.unshift(`The text says ${said}, but the link is not a web address.`);
  }
  return { href: clean, scheme, host, internal: false, refused: null, warnings };
}

export function copy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  }
  area.remove();
  return done;
}

/**
 * Shows where a link goes; an inner link can be followed, an outer one only copied, since GRT opens no web page.
 * @param {{follow?: (target: string) => void, toast?: (message: string) => void}} [options]
 */
export async function showLink(href, text = '', { follow = null, toast = null } = {}) {
  const link = examineLink(href, text);
  const warnings = link.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  const body = `
    <p>${link.internal ? 'This link goes to a place in this document:' : 'This link goes to:'}</p>
    <p class="link-target"><code>${escapeHtml(link.href || '(nothing)')}</code></p>
    ${link.refused ? `<p class="link-refused">${escapeHtml(link.refused)}</p>` : ''}
    ${warnings ? `<ul class="problem-list">${warnings}</ul>` : ''}
    ${!link.internal && !link.refused ? '<p class="hint">GRT does not open web pages. Copy the address to open it yourself, if you trust it.</p>' : ''}`;
  const choices = [{ id: 'close', label: 'Close', primary: !!link.refused }];
  if (link.internal && follow) choices.push({ id: 'go', label: 'Go there', primary: true });
  else if (!link.refused) choices.push({ id: 'copy', label: 'Copy address', primary: true });
  const answer = await showChoice('Where this link goes', body, choices);
  if (answer === 'go') follow(link.href.slice(1));
  if (answer === 'copy') toast?.(copy(link.href) ? 'Address copied' : 'The address could not be copied');
  return { ...link, answer };
}
