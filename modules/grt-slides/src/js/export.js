/** HTML, SVG, PNG and PDF. */

import { SlidesModel, fontStack } from './model.js';
import { fontFaceRules } from './fonts.js';

const escape = (value) => String(value ?? '')
  .replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));

const round = (value) => Math.round(value * 100) / 100;

/** Inline CSS for one element's box. */
function boxStyle(element) {
  const parts = [
    `left:${round(element.x)}px`,
    `top:${round(element.y)}px`,
    `width:${round(element.w)}px`,
    `height:${round(element.h)}px`,
    `z-index:${element.z ?? 1}`,
  ];
  if (element.rotation) parts.push(`transform:rotate(${element.rotation}deg)`);
  return parts.join(';');
}

/** Font stack for a name. */
let stackFor = fontStack;

/** Inline CSS for a text element. */
function textStyle(style, element = {}) {
  return [
    `font-size:${style.size ?? 32}px`,
    `color:${element.color ?? style.color ?? '#333333'}`,
    `text-align:${style.align ?? 'left'}`,
    `font-weight:${style.bold ? '700' : '400'}`,
    `font-style:${style.italic ? 'italic' : 'normal'}`,
    `font-family:${stackFor(element.font ?? style.font)}`,
  ].join(';');
}

/** One run of text, with its own formatting. */
export function runMarkup(run) {
  let html = escape(run.text).replace(/\n/g, '<br>');
  if (run.bold) html = `<strong>${html}</strong>`;
  if (run.italic) html = `<em>${html}</em>`;
  if (run.underline) html = `<u>${html}</u>`;
  if (run.color) html = `<span style="color:${escape(run.color)}">${html}</span>`;
  return html;
}

/**
 * One element as HTML.
 * @param {Object} element
 * @param {SlidesModel} model
 * @param {Map<string, string>} images resource path to data URL
 */
export function elementMarkup(element, model, images = new Map()) {
  const style = model.styles[element.style] ?? model.styles.body ?? {};

  if (element.kind === 'text') {
    const runs = (element.content ?? []).map(runMarkup).join('');
    return `<div class="el text" style="${boxStyle(element)};${textStyle(style, element)}">${runs}</div>`;
  }

  if (element.kind === 'image') {
    const source = images.get(element.resource);
    if (!source) {
      // A missing image is shown as an empty frame rather than silently
      // dropped.
      return `<div class="el missing" style="${boxStyle(element)}"></div>`;
    }
    const fit = element.fit === 'cover' ? 'cover' : 'contain';
    return `<div class="el" style="${boxStyle(element)}">`
      + `<img src="${source}" style="width:100%;height:100%;object-fit:${fit}" alt=""></div>`;
  }

  if (element.kind === 'shape') {
    const fill = escape(element.fill ?? model.theme.accent ?? '#1f6feb');
    // Drawn as inline SVG rather than a styled div.
    return `<div class="el" style="${boxStyle(element)}">`
      + `<svg viewBox="0 0 100 100" preserveAspectRatio="none" `
      + `style="width:100%;height:100%;display:block">`
      + shapePath(element.shape, fill)
      + '</svg></div>';
  }

  if (element.kind === 'table') {
    const style = model.styles[element.style] ?? model.styles.body ?? {};
    const line = escape(model.theme.text ?? '#666666');
    const rows = (element.cells ?? []).map((row, r) => {
      const cells = row.map((cell) => {
        const heading = element.header && r === 0;
        const weight = heading ? 'font-weight:700;' : '';
        return `<td style="border:1px solid ${line};padding:6px 10px;${weight}">`
          + `${escape(cell).replace(/\n/g, '<br>')}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    return `<div class="el table" style="${boxStyle(element)};${textStyle(style, element)}">`
      + `<table style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed">`
      + `${rows}</table></div>`;
  }

  if (element.kind === 'line') {
    const stroke = escape(element.fill ?? model.theme.accent ?? '#1f6feb');
    const thickness = element.thickness ?? 4;
    const marker = element.arrow
      ? `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" `
        + `markerHeight="5" orient="auto-start-reverse">`
        + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${stroke}"/></marker></defs>`
      : '';
    return `<div class="el" style="${boxStyle(element)}">`
      + `<svg viewBox="0 0 ${round(element.w)} ${round(element.h)}" `
      + `style="width:100%;height:100%;display:block;overflow:visible">${marker}`
      + `<line x1="0" y1="0" x2="${round(element.w)}" y2="${round(element.h)}" `
      + `stroke="${stroke}" stroke-width="${thickness}"`
      + `${element.arrow ? ' marker-end="url(#ah)"' : ''}/></svg></div>`;
  }

  return `<div class="el" style="${boxStyle(element)}"></div>`;
}

/** Transitions the exported file knows how to play (few and sober). */
const TRANSITIONS = new Set(['none', 'fade', 'slide']);

/**
 * One shape, in a 0-100 box that stretches to whatever the element's size is.
 */
export function shapePath(shape, fill) {
  const polygon = (points) => `<polygon points="${points}" fill="${fill}"/>`;

  switch (shape) {
    case 'ellipse':
      return `<ellipse cx="50" cy="50" rx="50" ry="50" fill="${fill}"/>`;
    case 'rounded':
      return `<rect x="0" y="0" width="100" height="100" rx="10" ry="10" fill="${fill}"/>`;
    case 'diamond':
      return polygon('50,0 100,50 50,100 0,50');
    case 'parallelogram':
      return polygon('20,0 100,0 80,100 0,100');
    case 'hexagon':
      return polygon('18,0 82,0 100,50 82,100 18,100 0,50');
    case 'triangle':
      return polygon('50,0 100,100 0,100');
    default:
      return `<rect x="0" y="0" width="100" height="100" fill="${fill}"/>`;
  }
}

/**
 * The whole deck as a single HTML file.
 * @param {SlidesModel} model
 * @param {Map<string, string>} images resource path to data URL
 * @param {{title?: string}} [options]
 * @returns {string}
 */
export function toHtml(model, images = new Map(), options = {}) {
  const { w, h } = model.canvas;

  // Custom fonts are embedded only when asked for.
  const embed = options.embedFonts !== false;
  stackFor = (name) => model.stackFor(name);
  const faces = embed ? fontFaceRules(model.fonts ?? [], images) : '';

  const slides = model.slides.map((slide, index) => {
    const elements = model.renderList(slide.id)
      .map((element) => elementMarkup(element, model, images))
      .join('');
    const background = escape(model.slideBackground(slide.id));
    const transition = TRANSITIONS.has(slide.transition) ? slide.transition : 'none';
    return `<section class="slide t-${transition}" data-index="${index}" `
      + `style="background:${background}">${elements}</section>`;
  }).join('\n');

  // A deliberately plain title.
  const title = escape(options.title ?? 'Presentation');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${faces}
html,body{margin:0;height:100%;background:#000;overflow:hidden;
  font-family:system-ui,sans-serif}
#stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#deck{position:relative;width:${w}px;height:${h}px;transform-origin:center center;
  background:${escape(model.theme.background ?? '#ffffff')};overflow:hidden}
.slide{position:absolute;inset:0;display:none}
.slide.current{display:block}
/* Few and sober: an elaborate transition catalogue costs work,
   distracts the audience, and nobody uses one twice. */
.slide.t-fade.current{animation:fade .28s ease}
.slide.t-slide.current{animation:slide .28s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes slide{from{transform:translateX(4%);opacity:.4}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){
  .slide.t-fade.current,.slide.t-slide.current{animation:none}
}
.el{position:absolute;box-sizing:border-box}
.el.text{white-space:pre-wrap;overflow-hidden;line-height:1.25}
.el.missing{border:2px dashed rgba(128,128,128,.6)}
#veil{position:absolute;inset:0;display:none;z-index:999}
#veil.on{display:block}
#count{position:absolute;right:14px;bottom:10px;color:rgba(128,128,128,.55);
  font-size:13px;z-index:998}
</style>
</head>
<body>
<div id="stage"><div id="deck">
${slides}
</div></div>
<div id="veil"></div>
<div id="count"></div>
<script>
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var deck=document.getElementById('deck');
  var veil=document.getElementById('veil');
  var count=document.getElementById('count');
  var at=0, typed='';

  function fit(){
    var s=Math.min(innerWidth/${w}, innerHeight/${h});
    deck.style.transform='scale('+s+')';
  }
  function show(i){
    at=Math.max(0,Math.min(i,slides.length-1));
    slides.forEach(function(s,n){ s.className='slide'+(n===at?' current':''); });
    count.textContent=(at+1)+' / '+slides.length;
  }
  function veilWith(colour){
    if(veil.classList.contains('on') && veil.style.background===colour){
      veil.classList.remove('on'); return;
    }
    veil.style.background=colour; veil.classList.add('on');
  }

  addEventListener('resize',fit);
  addEventListener('keydown',function(e){
    var k=e.key;
    if(k==='ArrowRight'||k==='ArrowDown'||k===' '||k==='PageDown'){e.preventDefault();show(at+1);}
    else if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp'){e.preventDefault();show(at-1);}
    else if(k==='Home'){show(0);}
    else if(k==='End'){show(slides.length-1);}
    else if(k==='b'||k==='B'){veilWith('#000');}
    else if(k==='w'||k==='W'){veilWith('#fff');}
    else if(k==='f'||k==='F'){
      if(document.fullscreenElement){document.exitFullscreen();}
      else{document.documentElement.requestFullscreen();}
    }
    else if(k>='0'&&k<='9'){
      typed+=k;
      clearTimeout(window.__t);
      window.__t=setTimeout(function(){ if(typed){show(parseInt(typed,10)-1);} typed=''; },700);
    }
  });
  addEventListener('click',function(e){ show(at + (e.clientX < innerWidth/3 ? -1 : 1)); });

  fit(); show(0);
})();
</script>
</body>
</html>
`;
}

/**
 * One slide as an SVG document, reusing the geometry the editor already has.
 */
export function slideToSvg(model, slideId, images = new Map()) {
  const { w, h } = model.canvas;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${escape(model.slideBackground(slideId))}"/>`,
  ];

  for (const element of model.renderList(slideId)) {
    if (element.kind === 'image') {
      const source = images.get(element.resource);
      if (source) {
        parts.push(`<image x="${round(element.x)}" y="${round(element.y)}" `
          + `width="${round(element.w)}" height="${round(element.h)}" href="${source}"/>`);
      }
      continue;
    }

    if (element.kind === 'shape') {
      const fill = escape(element.fill ?? model.theme.accent ?? '#1f6feb');
      parts.push(`<svg x="${round(element.x)}" y="${round(element.y)}" `
        + `width="${round(element.w)}" height="${round(element.h)}" `
        + `viewBox="0 0 100 100" preserveAspectRatio="none">`
        + shapePath(element.shape, fill) + '</svg>');
      continue;
    }

    if (element.kind === 'table') {
      const style = model.styles[element.style] ?? model.styles.body ?? {};
      const size = Math.min(style.size ?? 32, element.h / Math.max(element.rows, 1) * 0.5);
      const cw = element.w / element.cols;
      const ch = element.h / element.rows;
      const stroke = escape(model.theme.text ?? '#666666');

      for (let r = 0; r <= element.rows; r += 1) {
        const y = round(element.y + r * ch);
        parts.push(`<line x1="${round(element.x)}" y1="${y}" `
          + `x2="${round(element.x + element.w)}" y2="${y}" stroke="${stroke}"/>`);
      }
      for (let c = 0; c <= element.cols; c += 1) {
        const x = round(element.x + c * cw);
        parts.push(`<line x1="${x}" y1="${round(element.y)}" `
          + `x2="${x}" y2="${round(element.y + element.h)}" stroke="${stroke}"/>`);
      }
      (element.cells ?? []).forEach((row, r) => row.forEach((cell, c) => {
        if (!cell) return;
        parts.push(`<text x="${round(element.x + c * cw + 8)}" `
          + `y="${round(element.y + r * ch + ch / 2 + size / 3)}" `
          + `font-family="sans-serif" font-size="${round(size)}" `
          + `fill="${escape(element.color ?? style.color ?? '#333333')}"`
          + `${element.header && r === 0 ? ' font-weight="700"' : ''}>`
          + `${escape(cell)}</text>`);
      }));
      continue;
    }

    if (element.kind === 'line') {
      const stroke = escape(element.fill ?? model.theme.accent ?? '#1f6feb');
      parts.push(`<line x1="${round(element.x)}" y1="${round(element.y)}" `
        + `x2="${round(element.x + element.w)}" y2="${round(element.y + element.h)}" `
        + `stroke="${stroke}" stroke-width="${element.thickness ?? 4}"/>`);
      continue;
    }

    if (element.kind !== 'text') continue;

    const style = model.styles[element.style] ?? model.styles.body ?? {};
    const size = style.size ?? 32;
    const lines = wrapText(SlidesModel.plainText(element), element.w, size);

    lines.forEach((line, i) => {
      const family = (element.font ?? style.font) === 'serif' ? 'serif'
        : (element.font ?? style.font) === 'mono' ? 'monospace' : 'sans-serif';
      parts.push(`<text x="${round(element.x)}" y="${round(element.y + size * (1 + i * 1.25))}" `
        + `font-family="${family}" font-size="${size}" `
        + `fill="${escape(element.color ?? style.color ?? '#333333')}"`
        + `${style.bold ? ' font-weight="700"' : ''}>${escape(line)}</text>`);
    });
  }

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

/** Wraps text by character count. */
export function wrapText(text, width, size) {
  if (!text) return [];
  const perLine = Math.max(Math.floor(width / (size * 0.55)), 4);
  const lines = [];

  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && (`${line} ${word}`).length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }

  return lines;
}

/** One slide as primitives for the shared print engine. */
export function slideToPrintPage(model, slideId, imageBytes = new Map()) {
  const { w, h } = model.canvas;
  const primitives = [{
    type: 'rect', x: 0, y: 0, w, h, fill: model.slideBackground(slideId),
  }];

  for (const element of model.renderList(slideId)) {
    if (element.kind === 'shape') {
      const fill = element.fill ?? model.theme.accent ?? '#1f6feb';
      const points = shapeCorners(element);
      primitives.push(points
        ? { type: 'polygon', points, fill }
        : {
          type: element.shape === 'ellipse' ? 'ellipse' : 'rect',
          ...(element.shape === 'ellipse'
            ? {
              cx: element.x + element.w / 2, cy: element.y + element.h / 2,
              rx: element.w / 2, ry: element.h / 2,
            }
            : { x: element.x, y: element.y, w: element.w, h: element.h }),
          fill,
        });
      continue;
    }

    if (element.kind === 'table') {
      const style = model.styles[element.style] ?? model.styles.body ?? {};
      const cw = element.w / element.cols;
      const ch = element.h / element.rows;
      const size = Math.min(style.size ?? 32, ch * 0.45);

      for (let r = 0; r <= element.rows; r += 1) {
        const y = element.y + r * ch;
        primitives.push({
          type: 'polyline',
          points: [[element.x, y], [element.x + element.w, y]],
          stroke: model.theme.text ?? '#666666',
          strokeWidth: 1,
        });
      }
      for (let c = 0; c <= element.cols; c += 1) {
        const x = element.x + c * cw;
        primitives.push({
          type: 'polyline',
          points: [[x, element.y], [x, element.y + element.h]],
          stroke: model.theme.text ?? '#666666',
          strokeWidth: 1,
        });
      }
      (element.cells ?? []).forEach((row, r) => row.forEach((cell, c) => {
        if (!cell) return;
        primitives.push({
          type: 'text',
          x: element.x + c * cw + 8,
          y: element.y + r * ch + ch / 2 - size / 2,
          text: cell,
          size,
          fill: element.color ?? style.color ?? '#333333',
        });
      }));
      continue;
    }

    if (element.kind === 'line') {
      primitives.push({
        type: 'polyline',
        points: [[element.x, element.y], [element.x + element.w, element.y + element.h]],
        stroke: element.fill ?? model.theme.accent ?? '#1f6feb',
        strokeWidth: element.thickness ?? 4,
      });
      continue;
    }

    if (element.kind === 'image') {
      const bytes = imageBytes.get(element.resource);
      primitives.push(bytes
        ? {
          type: 'image', bytes,
          x: element.x, y: element.y, w: element.w, h: element.h,
        }
        : {
          // Only when the picture itself is missing.
          type: 'rect', x: element.x, y: element.y, w: element.w, h: element.h,
          stroke: '#bbbbbb', strokeWidth: 1,
        });
      continue;
    }

    if (element.kind !== 'text') continue;

    const style = model.styles[element.style] ?? model.styles.body ?? {};
    const size = style.size ?? 32;
    const lines = wrapText(SlidesModel.plainText(element), element.w, size);

    lines.forEach((line, i) => {
      primitives.push({
        type: 'text',
        x: style.align === 'center' ? element.x + element.w / 2 : element.x,
        y: element.y + i * size * 1.25,
        text: line,
        size,
        align: style.align === 'center' ? 'center' : 'left',
        fill: element.color ?? style.color ?? '#333333',
      });
    });
  }

  return { width: w, height: h, primitives };
}

/** Polygon corners for the shapes the print engine draws as polygons. */
function shapeCorners(element) {
  const { x, y, w, h } = element;
  switch (element.shape) {
    case 'diamond':
      return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    case 'parallelogram':
      return [[x + w * 0.2, y], [x + w, y], [x + w * 0.8, y + h], [x, y + h]];
    case 'hexagon':
      return [[x + w * 0.18, y], [x + w * 0.82, y], [x + w, y + h / 2],
        [x + w * 0.82, y + h], [x + w * 0.18, y + h], [x, y + h / 2]];
    case 'triangle':
      return [[x + w / 2, y], [x + w, y + h], [x, y + h]];
    default:
      // rect, rounded and ellipse have primitives of their own.
      return null;
  }
}
