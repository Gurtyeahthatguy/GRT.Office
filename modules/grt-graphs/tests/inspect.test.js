// @vitest-environment jsdom

/** The inspector for Graphs: the paths of live values, comments, links and data are gone from the clean copy. */

import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/js/model.js';
import { graphFindings, cleanGraphCopy } from '../src/js/inspect.js';
import { writeOdg } from '../src/js/core/formats/odg.js';
import { encodeBlock } from '../src/js/core/package.js';

describe('the inspector of a diagram', () => {
  it('lists the paths behind live values and the rest, and the clean copy has none of what is ticked', () => {
    const model = new GraphModel();
    const node = model.addNode({ x: 0, y: 0, text: 'Sales: 40', data: { owner: 'Mario' } });
    node.live = { path: '/home/someone/Private/sales.ods', cell: 'B2' };
    model.setLink([node.id], 'https://intranet.example.com/');
    model.addComment({ x: 10, y: 10, text: 'Ask Luigi' });
    expect(Object.fromEntries(graphFindings(model).map((f) => [f.id, f.count]))).toEqual({ live: 1, comments: 1, links: 1, data: 1 });
    const copy = cleanGraphCopy(model, ['live', 'comments', 'links', 'data']);
    const all = JSON.stringify(copy) + new TextDecoder().decode(encodeBlock(writeOdg(copy).entries));
    for (const secret of ['/home/someone', 'intranet.example.com', 'Luigi', 'Mario']) expect(all.includes(secret), secret).toBe(false);
    expect(all.includes('Sales: 40')).toBe(true);
  });
});
