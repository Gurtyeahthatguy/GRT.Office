/** Planning: nodes with a duration and the arrows between them as dependencies; the critical path, the Gantt chart, and the deadlines as a calendar for Dates. */

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** A node's duration in days, from its data; null when it has none. */
export function durationOf(node) {
  const raw = node?.data?.duration ?? node?.data?.days;
  const days = Number(String(raw ?? '').replace(',', '.'));
  return raw !== undefined && raw !== '' && Number.isFinite(days) && days >= 0 && days <= 100000 ? days : null;
}

const isoDay = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const dayMs = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
};

/**
 * The critical path method over the nodes that have a duration: earliest and latest start and finish, slack, and what is critical.
 * @param {{nodes: object[], edges: object[]}} model
 * @param {{start?: string}} options the project's first day, YYYY-MM-DD
 * @returns {{tasks: object[], edges: Set<string>, finish: number, cycle: ?string[]}}
 */
export function criticalPath(model, { start = null } = {}) {
  const tasks = new Map(model.nodes.filter((n) => durationOf(n) !== null).map((n) => [n.id, { id: n.id, name: String(n.text || n.id), duration: durationOf(n), before: [], after: [] }]));
  const links = model.edges.filter((e) => tasks.has(e.from) && tasks.has(e.to) && e.from !== e.to);
  for (const e of links) {
    tasks.get(e.to).before.push(e.from);
    tasks.get(e.from).after.push(e.to);
  }
  // An order where every task comes after those it waits for; a loop has none.
  const order = [];
  const waiting = new Map([...tasks.values()].map((t) => [t.id, t.before.length]));
  const ready = [...tasks.values()].filter((t) => t.before.length === 0).map((t) => t.id);
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const next of tasks.get(id).after) {
      waiting.set(next, waiting.get(next) - 1);
      if (waiting.get(next) === 0) ready.push(next);
    }
  }
  if (order.length < tasks.size) {
    return { tasks: [], edges: new Set(), finish: 0, cycle: [...tasks.values()].filter((t) => waiting.get(t.id) > 0).map((t) => t.name) };
  }
  for (const id of order) {
    const t = tasks.get(id);
    t.es = Math.max(0, ...t.before.map((b) => tasks.get(b).ef));
    t.ef = t.es + t.duration;
  }
  const finish = Math.max(0, ...[...tasks.values()].map((t) => t.ef));
  for (const id of [...order].reverse()) {
    const t = tasks.get(id);
    t.lf = Math.min(finish, ...t.after.map((a) => tasks.get(a).ls));
    t.ls = t.lf - t.duration;
    t.slack = Math.round((t.ls - t.es) * 1000) / 1000;
    t.critical = t.slack === 0;
  }
  const first = dayMs(start);
  for (const t of tasks.values()) {
    if (first !== null) {
      t.startDate = isoDay(first + Math.floor(t.es) * DAY);
      // A task of three days that starts on the 1st ends on the 3rd.
      t.endDate = isoDay(first + Math.max(Math.floor(t.es), Math.ceil(t.ef) - 1) * DAY);
    }
  }
  const critical = new Set(links.filter((e) => tasks.get(e.from).critical && tasks.get(e.to).critical && tasks.get(e.from).ef === tasks.get(e.to).es).map((e) => e.id));
  const sorted = order.map((id) => tasks.get(id)).sort((a, b) => a.es - b.es || a.name.localeCompare(b.name));
  return { tasks: sorted, edges: critical, finish, cycle: null };
}

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The Gantt chart as SVG: a bar for each task, the critical ones in the accent colour, the days along the top. */
export function ganttSvg(plan, { start = null, width = 900 } = {}) {
  const label = Math.min(180, Math.round(width * 0.28));
  const row = 26;
  const span = Math.max(1, Math.ceil(plan.finish));
  const scale = (width - label - 20) / span;
  const height = 40 + plan.tasks.length * row + 10;
  const first = dayMs(start);
  const step = Math.max(1, Math.ceil(span / 20));
  const ticks = [];
  for (let d = 0; d <= span; d += step) {
    const x = label + d * scale;
    const text = first !== null ? isoDay(first + d * DAY).slice(5) : `${d}`;
    ticks.push(`<line x1="${x}" y1="28" x2="${x}" y2="${height - 10}" stroke="#d0d7de" stroke-width="1"/><text x="${x + 2}" y="20" font-size="10" fill="#57606a">${esc(text)}</text>`);
  }
  const bars = plan.tasks.map((t, i) => {
    const y = 36 + i * row;
    const x = label + t.es * scale;
    const w = Math.max(2, t.duration * scale);
    const slack = t.slack > 0 ? `<rect x="${x + w}" y="${y + 8}" width="${t.slack * scale}" height="4" fill="#d0d7de"/>` : '';
    return `<text x="6" y="${y + 14}" font-size="12" fill="#24292f">${esc(t.name.slice(0, Math.floor(label / 7)))}</text>`
      + `<rect x="${x}" y="${y}" width="${w}" height="18" rx="3" fill="${t.critical ? '#cf222e' : '#1f6feb'}"/>${slack}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif"><rect width="${width}" height="${height}" fill="#ffffff"/>${ticks.join('')}${bars}</svg>`;
}

/** The tasks as an iCalendar file of to-dos, each due on its last day, for Dates to open. */
export function deadlinesIcs(plan, { title = 'Project' } = {}) {
  const text = (value) => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const compact = (iso) => iso.replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GRT//Graphs//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${text(title)}`];
  for (const t of plan.tasks) {
    if (!t.endDate) continue;
    lines.push('BEGIN:VTODO', `UID:${t.id}@grt-graphs`, 'DTSTAMP:19800101T000000Z', `SUMMARY:${text(t.name)}`,
      `DTSTART;VALUE=DATE:${compact(t.startDate)}`, `DUE;VALUE=DATE:${compact(t.endDate)}`,
      `DESCRIPTION:${text(`${t.duration} day(s)${t.critical ? ', on the critical path' : `, ${t.slack} day(s) of slack`}`)}`,
      ...(t.critical ? ['PRIORITY:1'] : []), 'STATUS:NEEDS-ACTION', 'END:VTODO');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
