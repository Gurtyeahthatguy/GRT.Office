/** The document inspector for Graphs: what a drawing carries besides what shows, on every page, and a clean copy without it. */

const allNodes = (model) => model.pages.flatMap((p) => p.nodes);

export function graphFindings(model) {
  const nodes = allNodes(model);
  const comments = model.pages.reduce((n, p) => n + (p.comments ?? []).length, 0);
  const described = model.pages.flatMap((p) => [...p.nodes, ...(p.objects ?? [])]).filter((o) => o.name || o.title || o.description);
  return [
    { id: 'live', label: 'Paths of the files live values come from', count: nodes.filter((n) => n.live?.path).length, detail: 'Full paths name your folders; the copy keeps the values as text' },
    { id: 'comments', label: 'Comments', count: comments },
    { id: 'names', label: 'Names and descriptions of shapes', count: described.length, keep: true },
    { id: 'links', label: 'Links on nodes', count: nodes.filter((n) => n.link).length, keep: true },
    { id: 'data', label: 'Data fields on nodes', count: nodes.filter((n) => Object.keys(n.data ?? {}).length).length, keep: true },
  ];
}

export function cleanGraphCopy(model, out) {
  const copy = model.toJSON();
  for (const page of copy.pages) {
    for (const node of page.nodes) {
      if (out.includes('live')) delete node.live;
      if (out.includes('links')) delete node.link;
      if (out.includes('data')) node.data = {};
    }
    for (const thing of [...page.nodes, ...(page.objects ?? [])]) {
      if (out.includes('names')) { delete thing.name; delete thing.title; delete thing.description; }
    }
    if (out.includes('comments')) page.comments = [];
  }
  // The first page, as older versions read it, is the cleaned one.
  copy.nodes = copy.pages[0].nodes;
  copy.edges = copy.pages[0].edges;
  if (out.includes('comments')) delete copy.meta.comments;
  return copy;
}
