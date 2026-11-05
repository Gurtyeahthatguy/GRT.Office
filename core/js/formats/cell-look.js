/** A cell's look as Grid keeps it, and its borders in the words ODF and OOXML use. */

/** The fields of a look that describe the cell; `name` and `parent` only say where it came from. */
export const LOOK_FIELDS = ['bold', 'italic', 'underline', 'strike', 'color', 'font', 'size', 'bg', 'align', 'valign', 'wrap', 'indent', 'rotate', 'borders', 'format'];

export const SIDES = ['top', 'right', 'bottom', 'left'];

/** A look with only the fields that say something, borders included only when one is drawn. */
export function cleanLook(look) {
  const out = {};
  for (const field of LOOK_FIELDS) {
    const value = look?.[field];
    if (value === undefined || value === null || value === false || value === '' || value === 0) continue;
    if (field === 'borders') {
      const borders = {};
      for (const side of SIDES) if (value[side]) borders[side] = { ...value[side] };
      if (Object.keys(borders).length) out.borders = borders;
      continue;
    }
    out[field] = value;
  }
  return out;
}

/** The look without what the file's default gives every cell anyway. */
export function withoutDefaults(look, defaults) {
  const out = { ...look };
  for (const [field, value] of Object.entries(defaults ?? {})) {
    if (JSON.stringify(out[field]) === JSON.stringify(value)) delete out[field];
  }
  return out;
}

export const sameLook = (a, b) => JSON.stringify(cleanLook(a)) === JSON.stringify(cleanLook(b));

// Widths in pixels: 1 thin, 2 medium, 3 thick, as Excel and LibreOffice name them.
const ODF_WIDTH = { 1: '0.74pt', 2: '1.76pt', 3: '2.49pt' };

/** An ODF border such as `0.74pt solid #000000`, or null for none. */
export function borderFromOdf(text) {
  const value = String(text ?? '').trim();
  if (!value || value === 'none' || /^0(\.0+)?\w*\s/.test(value)) return null;
  const parts = value.split(/\s+/);
  const style = parts.find((p) => ['solid', 'dashed', 'dotted', 'double', 'dash-dot', 'dash-dot-dot', 'fine-dashed', 'wave'].includes(p)) ?? 'solid';
  if (style === 'none' || parts.includes('none')) return null;
  const color = parts.find((p) => /^#[0-9a-f]{6}$/i.test(p))?.toLowerCase() ?? '#000000';
  const length = parts.find((p) => /^[\d.]+(pt|cm|mm|in|px)$/.test(p)) ?? '0.74pt';
  const pt = toPoints(length);
  return {
    style: { 'fine-dashed': 'dashed', 'dash-dot': 'dashed', 'dash-dot-dot': 'dashed', wave: 'solid' }[style] ?? style,
    width: style === 'double' ? 3 : pt < 1.2 ? 1 : pt < 2.2 ? 2 : 3,
    color,
  };
}

export function borderToOdf(border) {
  if (!border) return null;
  const style = border.style ?? 'solid';
  const width = style === 'double' ? '2.49pt' : ODF_WIDTH[border.width ?? 1] ?? ODF_WIDTH[1];
  return `${width} ${style} ${border.color ?? '#000000'}`;
}

function toPoints(length) {
  const n = parseFloat(length);
  if (length.endsWith('cm')) return n * 72 / 2.54;
  if (length.endsWith('mm')) return n * 72 / 25.4;
  if (length.endsWith('in')) return n * 72;
  if (length.endsWith('px')) return n * 0.75;
  return n;
}

const FROM_XLSX = {
  hair: { style: 'dotted', width: 1 }, thin: { style: 'solid', width: 1 }, medium: { style: 'solid', width: 2 }, thick: { style: 'solid', width: 3 },
  dashed: { style: 'dashed', width: 1 }, mediumDashed: { style: 'dashed', width: 2 }, dotted: { style: 'dotted', width: 1 }, double: { style: 'double', width: 3 },
  dashDot: { style: 'dashed', width: 1 }, mediumDashDot: { style: 'dashed', width: 2 }, dashDotDot: { style: 'dashed', width: 1 },
  mediumDashDotDot: { style: 'dashed', width: 2 }, slantDashDot: { style: 'dashed', width: 2 },
};

/** An OOXML border side's style name and colour as a border, or null. */
export function borderFromXlsx(name, color) {
  const found = FROM_XLSX[name];
  return found ? { ...found, color: color ?? '#000000' } : null;
}

export function borderToXlsx(border) {
  if (!border) return null;
  if (border.style === 'double') return 'double';
  if (border.style === 'dotted') return 'dotted';
  if (border.style === 'dashed') return (border.width ?? 1) > 1 ? 'mediumDashed' : 'dashed';
  return { 1: 'thin', 2: 'medium', 3: 'thick' }[border.width ?? 1] ?? 'thin';
}
