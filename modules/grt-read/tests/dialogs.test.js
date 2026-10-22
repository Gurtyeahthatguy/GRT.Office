// @vitest-environment jsdom

/** The forms show what they hold, as typed. */

import { describe, it, expect } from 'vitest';
import { metadataForm, stampForm } from '../src/js/dialogs.js';

const fields = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return Object.fromEntries([...host.querySelectorAll('[data-field]')].map((f) => [f.dataset.field, f.value]));
};

describe('the metadata form', () => {
  it('leaves empty fields empty, not "undefined"', () => {
    const values = fields(metadataForm({}));
    for (const key of ['title', 'author', 'subject', 'keywords', 'creator', 'producer']) expect(values[key]).toBe('');
  });

  it('shows a value as it is, quotes and all', () => {
    expect(fields(metadataForm({ title: 'Q&A "draft" 50%' })).title).toBe('Q&A "draft" 50%');
  });
});

describe('the stamp form', () => {
  it('shows the page number pattern with its braces', () => {
    expect(fields(stampForm({})).numbersFormat).toBe('{n}');
    expect(fields(stampForm({ pageNumbers: { format: 'Page {n} of {total}' } })).numbersFormat).toBe('Page {n} of {total}');
  });

  it('shows a watermark with spaces as typed', () => {
    expect(fields(stampForm({ watermark: { text: 'Not for release' } })).watermarkText).toBe('Not for release');
  });
});
