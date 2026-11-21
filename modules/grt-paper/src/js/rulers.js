/** The rulers above and beside the page, as Writer has them: centimetres from the margin, the margins and the paragraph's indent dragged to change them. */

import { PT } from './core/editor/render.js';

const HANDLE = 5;

/**
 * @param {Object} app scroll, sheet, surface, model(), indentHere() the chosen paragraph's indent in points,
 *   setMargins(margins) in millimetres, setIndent(points), shown() {h, v}
 */
export function paperRulers(app) {
  const h = document.createElement('div');
  h.className = 'ruler ruler-h';
  h.setAttribute('aria-hidden', 'true');
  const hc = document.createElement('canvas');
  h.append(hc);
  const v = document.createElement('div');
  v.className = 'ruler ruler-v';
  v.setAttribute('aria-hidden', 'true');
  const vc = document.createElement('canvas');
  v.append(vc);
  app.scroll.prepend(h);
  app.scroll.before(v);

  let drag = null;
  const colors = () => {
    const style = getComputedStyle(document.documentElement);
    return {
      back: style.getPropertyValue('--bg-sunken').trim() || '#eee',
      page: style.getPropertyValue('--bg').trim() || '#fff',
      ink: style.getPropertyValue('--text-dim').trim() || '#666',
      accent: style.getPropertyValue('--accent').trim() || '#2a6',
    };
  };

  /** The page's place on screen and how many pixels a millimetre takes. */
  function geometry() {
    const sheet = app.sheet.getBoundingClientRect();
    const box = app.model().pageBox();
    return { sheet, perMm: sheet.width / box.width, margins: app.model().page.margins, box };
  }

  const sized = (canvas, w, hgt) => {
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(hgt * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(hgt * ratio);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return ctx;
  };

  /** Ticks every millimetre run, numbered by the centimetre, counting away from the margin both ways. */
  function ticks(ctx, from, to, zero, perMm, across, vertical, ink) {
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const step = perMm < 1.2 ? 5 : 1;
    const first = Math.ceil((from - zero) / perMm / step) * step;
    for (let mm = first; zero + mm * perMm <= to; mm += step) {
      const at = Math.round(zero + mm * perMm) + 0.5;
      if (mm % 10 === 0) {
        if (mm !== 0) {
          if (vertical) { ctx.save(); ctx.translate(across / 2, at); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Math.abs(mm / 10)), 0, 0); ctx.restore(); } else ctx.fillText(String(Math.abs(mm / 10)), at, across / 2);
        }
      } else {
        const len = mm % 5 === 0 ? across * 0.35 : across * 0.15;
        ctx.beginPath();
        if (vertical) { ctx.moveTo(across / 2 - len / 2, at); ctx.lineTo(across / 2 + len / 2, at); } else { ctx.moveTo(at, across / 2 - len / 2); ctx.lineTo(at, across / 2 + len / 2); }
        ctx.stroke();
      }
    }
  }

  /** Where the horizontal ruler's handles are, in its own pixels. */
  function handlesH() {
    const { sheet, perMm, margins } = geometry();
    const left = sheet.left - app.scroll.getBoundingClientRect().left;
    const textLeft = left + margins.left * perMm;
    return {
      left, perMm, margins,
      marginLeft: textLeft,
      marginRight: left + sheet.width - margins.right * perMm,
      indent: textLeft + (app.indentHere() * PT * perMm) / (96 / 25.4),
    };
  }

  function drawH() {
    const width = app.scroll.clientWidth;
    const ctx = sized(hc, width, 18);
    if (!ctx) return;
    const c = colors();
    ctx.fillStyle = c.back;
    ctx.fillRect(0, 0, width, 18);
    const g = handlesH();
    const shown = drag?.ruler === 'h' ? { ...g, [drag.handle]: drag.at } : g;
    const right = g.left + app.sheet.getBoundingClientRect().width;
    ctx.fillStyle = c.page;
    ctx.fillRect(shown.marginLeft, 2, shown.marginRight - shown.marginLeft, 14);
    ticks(ctx, g.left, right, shown.marginLeft, g.perMm, 18, false, c.ink);
    // The indent, a small triangle under the line where the paragraph's lines start.
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(shown.indent - 4, 17);
    ctx.lineTo(shown.indent + 4, 17);
    ctx.lineTo(shown.indent, 11);
    ctx.closePath();
    ctx.fill();
  }

  /** Each page's top and bottom edge, on screen, from the page breaks drawn between them. */
  function pageEdges() {
    const sheet = app.sheet.getBoundingClientRect();
    const edges = [];
    let top = sheet.top;
    for (const marker of app.surface.querySelectorAll('.page-break')) {
      const r = marker.getBoundingClientRect();
      edges.push({ top, bottom: r.top });
      top = r.bottom;
    }
    edges.push({ top, bottom: sheet.bottom });
    return edges;
  }

  function drawV() {
    const height = app.scroll.clientHeight;
    const ctx = sized(vc, 18, height);
    if (!ctx) return;
    const c = colors();
    ctx.fillStyle = c.back;
    ctx.fillRect(0, 0, 18, height);
    const { perMm, margins } = geometry();
    const origin = app.scroll.getBoundingClientRect().top;
    for (const { top, bottom } of pageEdges()) {
      const y0 = top - origin;
      const y1 = bottom - origin;
      if (y1 < 0 || y0 > height) continue;
      const textTop = y0 + margins.top * perMm;
      ctx.fillStyle = c.page;
      ctx.fillRect(2, textTop, 14, Math.max(0, y1 - margins.bottom * perMm - textTop));
      ticks(ctx, Math.max(0, y0), Math.min(height, y1), textTop, perMm, 18, true, c.ink);
    }
  }

  function draw() {
    const shown = app.shown();
    h.classList.toggle('hidden', !shown.h);
    v.classList.toggle('hidden', !shown.v);
    if (shown.h) drawH();
    if (shown.v) drawV();
  }

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    (globalThis.requestAnimationFrame ?? setTimeout)(() => { pending = false; draw(); });
  };
  app.scroll.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(app.sheet);

  // Dragging a margin's edge or the indent changes it when let go, as Writer's ruler does.
  hc.addEventListener('pointerdown', (event) => {
    const x = event.offsetX;
    const g = handlesH();
    const near = ['indent', 'marginLeft', 'marginRight'].find((k) => Math.abs(g[k] - x) <= HANDLE);
    if (!near) return;
    event.preventDefault();
    hc.setPointerCapture(event.pointerId);
    drag = { ruler: 'h', handle: near, at: g[near], g };
  });
  hc.addEventListener('pointermove', (event) => {
    const g = handlesH();
    hc.style.cursor = ['indent', 'marginLeft', 'marginRight'].some((k) => Math.abs(g[k] - event.offsetX) <= HANDLE) ? 'ew-resize' : '';
    if (!drag) return;
    drag.at = event.offsetX;
    schedule();
  });
  hc.addEventListener('pointerup', () => {
    if (!drag) return;
    const { handle, at, g } = drag;
    drag = null;
    const mm = (px) => Math.round(px / g.perMm);
    if (handle === 'indent') {
      app.setIndent(Math.max(0, Math.round(((at - g.marginLeft) / g.perMm) * (96 / 25.4) / PT * 10) / 10));
    } else if (handle === 'marginLeft') {
      app.setMargins({ ...g.margins, left: Math.min(60, Math.max(5, mm(at - g.left))) });
    } else {
      const sheetWidth = app.sheet.getBoundingClientRect().width;
      app.setMargins({ ...g.margins, right: Math.min(60, Math.max(5, mm(g.left + sheetWidth - at))) });
    }
    schedule();
  });
  hc.addEventListener('lostpointercapture', () => { if (drag) { drag = null; schedule(); } });

  return { draw: schedule };
}
