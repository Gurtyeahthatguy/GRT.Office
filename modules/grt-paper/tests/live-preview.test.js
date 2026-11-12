// @vitest-environment jsdom

/** Live preview: the list shows each choice as it looks, previews it while pointed at, and chooses through the select. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { livePreview } from '../src/js/core/live-preview.js';

let select;
beforeEach(() => {
  document.body.innerHTML = '<select id="s" title="Style"><option value="body">Body</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option></select>';
  select = document.getElementById('s');
});

describe('live preview', () => {
  it('previews what is pointed at, puts things back when the pointer leaves, and chooses through the select', () => {
    const preview = vi.fn();
    const restore = vi.fn();
    const changed = vi.fn();
    select.addEventListener('change', () => changed(select.value));
    const control = livePreview(select, { preview, restore, look: (v) => (v === 'h1' ? { fontWeight: '700' } : {}) });
    const button = document.querySelector('.live-preview-button');
    expect(button.textContent).toBe('Body');
    button.click();
    const rows = [...document.querySelectorAll('.live-preview-list [role=option]')];
    expect(rows.map((r) => r.textContent)).toEqual(['Body', 'Heading 1', 'Heading 2']);
    expect(rows[1].style.fontWeight).toBe('700');
    rows[2].dispatchEvent(new MouseEvent('mouseenter'));
    expect(preview).toHaveBeenLastCalledWith('h2');
    document.querySelector('.live-preview-list').dispatchEvent(new MouseEvent('mouseleave'));
    expect(restore).toHaveBeenCalledTimes(1);
    rows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(changed).toHaveBeenCalledWith('h1');
    expect(document.querySelector('.live-preview-list')).toBeNull();
    select.value = 'h2';
    control.refresh();
    expect(button.textContent).toBe('Heading 2');
  });

  it('goes through the choices with the keys, and Escape puts things back', () => {
    const preview = vi.fn();
    const restore = vi.fn();
    livePreview(select, { preview, restore });
    const button = document.querySelector('.live-preview-button');
    const key = (k) => button.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    key('ArrowDown');
    expect(preview).toHaveBeenLastCalledWith('h1');
    key('Escape');
    expect(restore).toHaveBeenCalled();
    expect(select.value).toBe('body');
  });
});
