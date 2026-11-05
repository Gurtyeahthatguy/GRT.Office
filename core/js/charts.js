/** Charts drawn as SVG, the same on screen, in print and in PDF, for every program of the suite. */

export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'combo'];

/** Colours told apart in light and dark themes and by most kinds of colour blindness. */
export const SERIES_COLORS = ['#2f6fdf', '#e8743b', '#19a979', '#d64c8a', '#945ecf', '#13a4b4', '#bf8f00', '#6c8893', '#5899da', '#ed4a7b'];

/** The most series and points a chart draws, so a careless range cannot hang the interface. */
const MAX_SERIES = 64;
const MAX_POINTS = 4000;

const escape = (text) => String(text ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const round = (n) => Math.round(n * 100) / 100;

/** Axis steps of 1, 2 or 5 times a power of ten, enough to cover the values in about six steps. */
export function niceScale(min, max, steps = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  if (min === max) {
    if (min === 0) max = 1;
    else if (min > 0) min = 0;
    else max = 0;
  }
  const raw = (max - min) / steps;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const low = Math.floor(min / step + 1e-9) * step;
  const high = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = low; v <= high + step / 2 && ticks.length < 50; v += step) ticks.push(Number(v.toPrecision(12)));
  return { min: low, max: high, step, ticks };
}

/** A number as an axis shows it: short, with thousands as k and millions as M when they are long. */
export function axisLabel(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${Number((value / 1e9).toPrecision(3))}G`;
  if (abs >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`;
  if (abs >= 1e4) return `${Number((value / 1e3).toPrecision(3))}k`;
  return String(Number(value.toPrecision(6)));
}

/** A colour from a file or a person, kept only when it is a plain hex colour. */
const safeColor = (value, fallback) => (/^#[0-9a-f]{3,8}$/i.test(String(value ?? '')) ? value : fallback);

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The chart as an SVG document.
 * @param {{type: string, stacked?: false|'stacked'|'percent', title?: string, xTitle?: string, yTitle?: string,
 *   legend?: 'right'|'bottom'|'top'|'left'|'none', categories?: Array, series: {name?: string, values: Array, x?: Array, type?: string, color?: string}[]}} spec
 * @param {{width?: number, height?: number, font?: string, text?: string, grid?: string, background?: string}} options
 */
export function chartSvg(spec, options = {}) {
  const width = Math.max(80, options.width ?? 480);
  const height = Math.max(60, options.height ?? 300);
  const ink = safeColor(options.text, '#333333');
  const rule = safeColor(options.grid, '#d9d9d9');
  const font = options.font ?? 'system-ui, sans-serif';
  const type = CHART_TYPES.includes(spec.type) ? spec.type : 'column';
  const series = (spec.series ?? []).slice(0, MAX_SERIES).map((s, i) => ({
    ...s,
    name: s.name ?? `Series ${i + 1}`,
    values: (s.values ?? []).slice(0, MAX_POINTS).map(numeric),
    x: s.x ? s.x.slice(0, MAX_POINTS).map(numeric) : null,
    color: safeColor(s.color, SERIES_COLORS[i % SERIES_COLORS.length]),
    kind: type === 'combo' ? (s.type ?? (i === 0 ? 'column' : 'line')) : type,
  }));
  const count = Math.max(0, ...series.map((s) => s.values.length));
  const categories = Array.from({ length: count }, (_, i) => spec.categories?.[i] ?? String(i + 1));

  const parts = [];
  let top = 10;
  if (spec.title) {
    parts.push(`<text x="${width / 2}" y="${top + 14}" text-anchor="middle" font-size="15" font-weight="600" fill="${ink}">${escape(spec.title)}</text>`);
    top += 26;
  }
  const round_ = type === 'pie' || type === 'doughnut';
  const legendItems = round_ ? categories.map((c, i) => ({ name: c, color: SERIES_COLORS[i % SERIES_COLORS.length] })) : series.map((s) => ({ name: s.name, color: s.color }));
  const legend = spec.legend ?? 'right';
  let plot = { left: 10, top, right: width - 10, bottom: height - 10 };
  if (legend !== 'none' && legendItems.length > 0) {
    const drawn = drawLegend(legendItems, legend, plot, ink);
    parts.push(drawn.svg);
    plot = drawn.rest;
  }

  if (round_) parts.push(drawPie(series[0], categories, plot, type === 'doughnut', ink, safeColor(options.background, '#ffffff')));
  else if (series.length > 0) parts.push(drawAxes(spec, series, categories, plot, { type, ink, rule }));
  else parts.push(`<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="12" fill="${ink}" opacity="0.6">No data</text>`);

  const background = options.background ? `<rect width="${width}" height="${height}" fill="${safeColor(options.background, '#ffffff')}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escape(font)}" role="img" aria-label="${escape(spec.title || 'Chart')}">${background}${parts.join('')}</svg>`;
}

function drawLegend(items, where, plot, ink) {
  const rows = [];
  const swatch = (x, y, item) => `<rect x="${round(x)}" y="${round(y - 9)}" width="10" height="10" rx="2" fill="${item.color}"/><text x="${round(x + 14)}" y="${round(y)}" font-size="11" fill="${ink}">${escape(String(item.name).slice(0, 40))}</text>`;
  const widthOf = (item) => 22 + Math.min(40, String(item.name).length) * 6.2;
  const rest = { ...plot };
  if (where === 'bottom' || where === 'top') {
    let x = plot.left;
    let line = 0;
    const lines = [[]];
    for (const item of items) {
      if (x + widthOf(item) > plot.right && lines[line].length) { lines.push([]); line += 1; x = plot.left; }
      lines[line].push({ item, x });
      x += widthOf(item);
    }
    const shown = lines.slice(0, 3);
    const block = shown.length * 16;
    const y0 = where === 'bottom' ? plot.bottom - block + 11 : plot.top + 11;
    shown.forEach((line_, i) => {
      const used = line_.length ? line_[line_.length - 1].x + widthOf(line_[line_.length - 1].item) - plot.left : 0;
      const shift = (plot.right - plot.left - used) / 2;
      for (const { item, x: at } of line_) rows.push(swatch(at + shift, y0 + i * 16, item));
    });
    if (where === 'bottom') rest.bottom -= block + 6; else rest.top += block + 6;
  } else {
    const column = Math.min(160, Math.max(...items.map(widthOf)));
    const shown = items.slice(0, Math.max(1, Math.floor((plot.bottom - plot.top) / 16)));
    const y0 = (plot.top + plot.bottom) / 2 - (shown.length * 16) / 2 + 11;
    const x = where === 'left' ? plot.left : plot.right - column;
    shown.forEach((item, i) => rows.push(swatch(x, y0 + i * 16, item)));
    if (where === 'left') rest.left += column + 8; else rest.right -= column + 8;
  }
  return { svg: `<g class="legend">${rows.join('')}</g>`, rest };
}

function drawPie(series, categories, plot, doughnut, ink, hole = '#ffffff') {
  if (!series) return '';
  const values = series.values.map((v) => (v && v > 0 ? v : 0));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = (plot.left + plot.right) / 2;
  const cy = (plot.top + plot.bottom) / 2;
  const r = Math.max(10, Math.min(plot.right - plot.left, plot.bottom - plot.top) / 2 - 6);
  if (total <= 0) return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="none" stroke="${ink}" stroke-opacity="0.3"/>`;
  const out = [];
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const title = `<title>${escape(categories[i])}: ${escape(String(series.values[i]))}</title>`;
    if (sweep >= Math.PI * 2 - 1e-9) {
      out.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="${color}">${title}</circle>`);
    } else {
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + sweep);
      const y2 = cy + r * Math.sin(angle + sweep);
      out.push(`<path d="M${round(cx)},${round(cy)} L${round(x1)},${round(y1)} A${round(r)},${round(r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${round(x2)},${round(y2)} Z" fill="${color}" stroke="#ffffff" stroke-width="1">${title}</path>`);
    }
    const mid = angle + sweep / 2;
    if (sweep > 0.25) {
      const lr = doughnut ? r * 0.78 : r * 0.62;
      out.push(`<text x="${round(cx + lr * Math.cos(mid))}" y="${round(cy + lr * Math.sin(mid) + 4)}" text-anchor="middle" font-size="11" fill="#ffffff">${Math.round((v / total) * 100)}%</text>`);
    }
    angle += sweep;
  });
  if (doughnut) out.push(`<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r * 0.55)}" fill="${hole}"/>`);
  return `<g class="plot">${out.join('')}</g>`;
}

function drawAxes(spec, series, categories, plot, { type, ink, rule }) {
  const horizontal = type === 'bar';
  const scatter = type === 'scatter';
  const stacked = spec.stacked === 'stacked' || spec.stacked === 'percent' ? spec.stacked : false;
  const count = categories.length;

  // The values the scale has to hold: stacked series add up, percent ones fill to 100.
  const stackable = series.filter((s) => ['column', 'bar', 'area'].includes(s.kind));
  const totals = Array.from({ length: count }, (_, i) => stackable.reduce((sum, s) => sum + Math.abs(s.values[i] ?? 0), 0));
  let lowest = 0;
  let highest = 0;
  if (stacked === 'percent') highest = 100;
  else if (stacked) {
    for (let i = 0; i < count; i += 1) {
      let up = 0;
      let down = 0;
      for (const s of stackable) {
        const v = s.values[i] ?? 0;
        if (v >= 0) up += v; else down += v;
      }
      highest = Math.max(highest, up);
      lowest = Math.min(lowest, down);
    }
    for (const s of series) if (!stackable.includes(s)) for (const v of s.values) if (v !== null) { highest = Math.max(highest, v); lowest = Math.min(lowest, v); }
  } else {
    const all = series.flatMap((s) => s.values).filter((v) => v !== null);
    if (all.length) {
      highest = Math.max(...all);
      lowest = Math.min(...all);
      // Lines and points need not start at zero; columns, bars and areas do.
      if (series.some((s) => s.kind !== 'line' && s.kind !== 'scatter')) { highest = Math.max(highest, 0); lowest = Math.min(lowest, 0); }
    }
  }
  const scale = niceScale(lowest, highest);
  let xScale = null;
  if (scatter) {
    const xs = series.flatMap((s) => (s.x ?? s.values.map((_, i) => i + 1))).filter((v) => v !== null);
    xScale = niceScale(xs.length ? Math.min(...xs) : 0, xs.length ? Math.max(...xs) : 1);
  }

  // Room for the axis labels and titles.
  const valueLabels = scale.ticks.map(axisLabel);
  const labelWidth = Math.max(...valueLabels.map((l) => l.length)) * 6.5 + 8;
  const categoryWidth = horizontal ? Math.min(120, Math.max(...categories.map((c) => String(c).length)) * 6.5 + 8) : 0;
  const area = { ...plot };
  if (spec.yTitle) { if (horizontal) area.bottom -= 18; else area.left += 18; }
  if (spec.xTitle) { if (horizontal) area.left += 18; else area.bottom -= 18; }
  area.left += horizontal ? categoryWidth : labelWidth;
  area.bottom -= 20;
  area.right -= 6;
  area.top += 4;
  if (area.right - area.left < 20 || area.bottom - area.top < 20) return '';

  const out = [];
  const valueAt = (v) => (horizontal
    ? area.left + ((v - scale.min) / (scale.max - scale.min)) * (area.right - area.left)
    : area.bottom - ((v - scale.min) / (scale.max - scale.min)) * (area.bottom - area.top));
  const xAt = (v) => area.left + ((v - xScale.min) / (xScale.max - xScale.min)) * (area.right - area.left);
  const band = (horizontal ? area.bottom - area.top : area.right - area.left) / Math.max(1, count);
  const bandStart = (i) => (horizontal ? area.top + i * band : area.left + i * band);

  // Grid lines and value labels.
  scale.ticks.forEach((tick, i) => {
    const at = round(valueAt(tick));
    if (horizontal) {
      out.push(`<line x1="${at}" y1="${area.top}" x2="${at}" y2="${area.bottom}" stroke="${rule}" stroke-width="${tick === 0 ? 1.2 : 0.6}"/>`);
      out.push(`<text x="${at}" y="${round(area.bottom + 14)}" text-anchor="middle" font-size="10" fill="${ink}">${escape(valueLabels[i])}${stacked === 'percent' ? '%' : ''}</text>`);
    } else {
      out.push(`<line x1="${area.left}" y1="${at}" x2="${area.right}" y2="${at}" stroke="${rule}" stroke-width="${tick === 0 ? 1.2 : 0.6}"/>`);
      out.push(`<text x="${round(area.left - 5)}" y="${round(at + 3.5)}" text-anchor="end" font-size="10" fill="${ink}">${escape(valueLabels[i])}${stacked === 'percent' ? '%' : ''}</text>`);
    }
  });

  // Category labels, thinned out when they would overlap.
  if (scatter) {
    xScale.ticks.forEach((tick) => {
      const at = round(xAt(tick));
      out.push(`<line x1="${at}" y1="${area.top}" x2="${at}" y2="${area.bottom}" stroke="${rule}" stroke-width="0.4"/>`);
      out.push(`<text x="${at}" y="${round(area.bottom + 14)}" text-anchor="middle" font-size="10" fill="${ink}">${escape(axisLabel(tick))}</text>`);
    });
  } else {
    const every = horizontal ? Math.ceil(14 / band) : Math.ceil((Math.max(...categories.map((c) => String(c).length)) * 6 + 6) / band);
    categories.forEach((c, i) => {
      if (i % Math.max(1, every) !== 0) return;
      const mid = bandStart(i) + band / 2;
      const text = escape(String(c).slice(0, 24));
      if (horizontal) out.push(`<text x="${round(area.left - 5)}" y="${round(mid + 3.5)}" text-anchor="end" font-size="10" fill="${ink}">${text}</text>`);
      else out.push(`<text x="${round(mid)}" y="${round(area.bottom + 14)}" text-anchor="middle" font-size="10" fill="${ink}">${text}</text>`);
    });
  }
  out.push(horizontal
    ? `<line x1="${area.left}" y1="${area.top}" x2="${area.left}" y2="${area.bottom}" stroke="${ink}" stroke-opacity="0.6"/>`
    : `<line x1="${area.left}" y1="${area.bottom}" x2="${area.right}" y2="${area.bottom}" stroke="${ink}" stroke-opacity="0.6"/>`);

  // Titles of the axes.
  if (spec.xTitle) {
    out.push(horizontal
      ? `<text transform="translate(${round(plot.left + 10)},${round((area.top + area.bottom) / 2)}) rotate(-90)" text-anchor="middle" font-size="11" fill="${ink}">${escape(spec.xTitle)}</text>`
      : `<text x="${round((area.left + area.right) / 2)}" y="${round(plot.bottom - 2)}" text-anchor="middle" font-size="11" fill="${ink}">${escape(spec.xTitle)}</text>`);
  }
  if (spec.yTitle) {
    out.push(horizontal
      ? `<text x="${round((area.left + area.right) / 2)}" y="${round(plot.bottom - 2)}" text-anchor="middle" font-size="11" fill="${ink}">${escape(spec.yTitle)}</text>`
      : `<text transform="translate(${round(plot.left + 10)},${round((area.top + area.bottom) / 2)}) rotate(-90)" text-anchor="middle" font-size="11" fill="${ink}">${escape(spec.yTitle)}</text>`);
  }

  // The series: bars first, so lines and points sit on top of them.
  const bars = series.filter((s) => s.kind === 'column' || s.kind === 'bar');
  const base = Array.from({ length: count }, () => ({ up: 0, down: 0 }));
  const shown = (s, i) => {
    const v = s.values[i];
    if (v === null) return null;
    return stacked === 'percent' ? (totals[i] ? (v / totals[i]) * 100 : 0) : v;
  };
  const tip = (s, i) => `<title>${escape(s.name)}, ${escape(categories[i])}: ${escape(String(s.values[i] ?? ''))}</title>`;

  const areas = series.filter((s) => s.kind === 'area');
  const areaBase = Array.from({ length: count }, () => 0);
  for (const s of areas) {
    const upper = [];
    const lower = [];
    for (let i = 0; i < count; i += 1) {
      const v = shown(s, i) ?? 0;
      const from = stacked ? areaBase[i] : 0;
      const to = from + v;
      const x = bandStart(i) + band / 2;
      upper.push(`${round(x)},${round(valueAt(to))}`);
      lower.unshift(`${round(x)},${round(valueAt(from))}`);
      if (stacked) areaBase[i] = to;
    }
    out.push(`<polygon points="${[...upper, ...lower].join(' ')}" fill="${s.color}" fill-opacity="${stacked ? 0.85 : 0.45}" stroke="${s.color}" stroke-width="1.5"><title>${escape(s.name)}</title></polygon>`);
  }

  bars.forEach((s, k) => {
    const gap = band * 0.2;
    const slot = stacked ? band - gap * 2 : (band - gap * 2) / bars.length;
    for (let i = 0; i < count; i += 1) {
      const v = shown(s, i);
      if (v === null) continue;
      let from = 0;
      if (stacked) {
        from = v >= 0 ? base[i].up : base[i].down;
        if (v >= 0) base[i].up += v; else base[i].down += v;
      }
      const a = valueAt(from);
      const b = valueAt(from + v);
      const offset = bandStart(i) + gap + (stacked ? 0 : k * slot);
      const thick = Math.max(1, slot - (stacked ? 0 : 1));
      out.push(horizontal
        ? `<rect x="${round(Math.min(a, b))}" y="${round(offset)}" width="${round(Math.abs(b - a))}" height="${round(thick)}" fill="${s.color}">${tip(s, i)}</rect>`
        : `<rect x="${round(offset)}" y="${round(Math.min(a, b))}" width="${round(thick)}" height="${round(Math.abs(b - a))}" fill="${s.color}">${tip(s, i)}</rect>`);
    }
  });

  for (const s of series.filter((x) => x.kind === 'line' || x.kind === 'scatter')) {
    const points = [];
    for (let i = 0; i < count; i += 1) {
      const v = shown(s, i);
      if (v === null) { points.push(null); continue; }
      const x = scatter ? (s.x?.[i] ?? i + 1) : null;
      if (scatter && x === null) { points.push(null); continue; }
      points.push([scatter ? xAt(x) : bandStart(i) + band / 2, valueAt(v), i]);
    }
    if (s.kind === 'line') {
      let d = '';
      let pen = false;
      for (const p of points) {
        if (!p) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${round(p[0])},${round(p[1])} `;
        pen = true;
      }
      if (d) out.push(`<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`);
    }
    for (const p of points) {
      if (p) out.push(`<circle cx="${round(p[0])}" cy="${round(p[1])}" r="${s.kind === 'scatter' ? 3.5 : 2.5}" fill="${s.color}">${tip(s, p[2])}</circle>`);
    }
  }
  return `<g class="plot">${out.join('')}</g>`;
}
