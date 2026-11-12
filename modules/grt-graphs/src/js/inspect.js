/** The document inspector for Graphs: what a diagram carries besides what shows, and a clean copy without it. */

export function graphFindings(model) {
  const live = model.nodes.filter((n) => n.live?.path);
  return [
    { id: 'live', label: 'Paths of the files live values come from', count: live.length, detail: 'Full paths name your folders; the copy keeps the values as text' },
    { id: 'comments', label: 'Comments', count: model.comments.length },
    { id: 'links', label: 'Links on nodes', count: model.nodes.filter((n) => n.link).length, keep: true },
    { id: 'data', label: 'Data fields on nodes', count: model.nodes.filter((n) => Object.keys(n.data ?? {}).length).length, keep: true },
  ];
}

export function cleanGraphCopy(model, out) {
  const copy = model.toJSON();
  for (const node of copy.nodes) {
    if (out.includes('live')) delete node.live;
    if (out.includes('links')) delete node.link;
    if (out.includes('data')) node.data = {};
  }
  if (out.includes('comments')) delete copy.meta.comments;
  return copy;
}
