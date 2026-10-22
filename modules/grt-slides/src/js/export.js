/** HTML, SVG, PNG and PDF. */

import { SlidesModel, fontStack } from './model.js';
import { fontFaceRules } from './fonts.js';
import { parsePath, mapPath, formatPath, presetOutline } from './core/paths.js';

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

/** How an element's text looks: its named style, with what the element sets for itself. */
export function textLook(element, model) {
  const style = model.styles[element.style] ?? model.styles.body ?? {};
  return {
    size: element.size ?? style.size ?? 32,
    align: element.align ?? style.align ?? 'left',
    valign: element.valign ?? 'top',
    color: element.color ?? style.color ?? '#333333',
    bold: !!style.bold,
    italic: !!style.italic,
    font: element.font ?? style.font,
  };
}

const JUSTIFY = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

/** Inline CSS for a text element. */
function textStyle(look) {
  return [
    `font-size:${look.size}px`,
    `color:${look.color}`,
    `text-align:${look.align}`,
    `font-weight:${look.bold ? '700' : '400'}`,
    `font-style:${look.italic ? 'italic' : 'normal'}`,
    `font-family:${stackFor(look.font)}`,
    ...(look.valign !== 'top' ? ['display:flex', 'flex-direction:column', `justify-content:${JUSTIFY[look.valign] ?? 'flex-start'}`] : []),
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
  if (element.kind === 'text') {
    const look = textLook(element, model);
    const runs = (element.content ?? []).map(runMarkup).join('');
    // Anchored text is one block, moved as a whole inside the box.
    const body = look.valign !== 'top' ? `<div>${runs}</div>` : runs;
    return `<div class="el text" style="${escape(`${boxStyle(element)};${textStyle(look)}`)}">${body}</div>`;
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
    const fill = escape(shapeFill(element, model));
    // Drawn as inline SVG rather than a styled div.
    return `<div class="el" style="${boxStyle(element)}">`
      + `<svg viewBox="0 0 100 100" preserveAspectRatio="none" `
      + `style="width:100%;height:100%;display:block;overflow:visible">`
      + shapePath(element.shape, fill, element.stroke ? escape(element.stroke) : null, element.strokeWidth ?? 2, element.path)
      + '</svg></div>';
  }

  if (element.kind === 'table') {
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

    return `<div class="el table" style="${escape(`${boxStyle(element)};${textStyle({ ...textLook(element, model), valign: 'top' })}`)}">`
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
    const [x1, y1, x2, y2] = lineEnds({ ...element, x: 0, y: 0 });
    return `<div class="el" style="${boxStyle(element)}">`
      + `<svg viewBox="0 0 ${round(element.w)} ${round(element.h)}" `
      + `style="width:100%;height:100%;display:block;overflow:visible">${marker}`
      + `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" `
      + `stroke="${stroke}" stroke-width="${thickness}"`
      + `${element.arrow ? ' marker-end="url(#ah)"' : ''}/></svg></div>`;
  }

  return `<div class="el" style="${boxStyle(element)}"></div>`;
}

/** Transitions the exported file knows how to play (few and sober). */
const TRANSITIONS = new Set(['none', 'fade', 'slide']);

/** Where a line starts and ends; a flipped line runs across its box the other way. */
export function lineEnds(element) {
  const { x, y, w, h } = element;
  return [
    element.flipH ? x + w : x, element.flipV ? y + h : y,
    element.flipH ? x : x + w, element.flipV ? y : y + h,
  ];
}

/** A shape's fill, which may be none at all. */
export function shapeFill(element, model) {
  return element.fill ?? model.theme.accent ?? '#1f6feb';
}

/**
 * One shape, in a 0-100 box that stretches to whatever the element's size is.
 */
export function shapePath(shape, fill, stroke = null, strokeWidth = 2, path = null) {
  const paint = `fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"` : ''}`;
  const polygon = (points) => `<polygon points="${points}" ${paint}/>`;

  switch (shape) {
    case 'path':
      return `<path d="${escape(path ?? 'M0 0 L100 0 L100 100 L0 100 Z')}" ${paint}/>`;
    case 'ellipse':
      return `<ellipse cx="50" cy="50" rx="50" ry="50" ${paint}/>`;
    case 'rounded':
      return `<rect x="0" y="0" width="100" height="100" rx="10" ry="10" ${paint}/>`;
    case 'diamond':
      return polygon('50,0 100,50 50,100 0,50');
    case 'parallelogram':
      return polygon('20,0 100,0 80,100 0,100');
    case 'hexagon':
      return polygon('18,0 82,0 100,50 82,100 18,100 0,50');
    case 'triangle':
      return polygon('50,0 100,100 0,100');
    default:
      return `<rect x="0" y="0" width="100" height="100" ${paint}/>`;
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
.el.text{white-space:pre-wrap;overflow:hidden;line-height:1.25}
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
      const fill = escape(shapeFill(element, model));
      parts.push(`<svg x="${round(element.x)}" y="${round(element.y)}" `
        + `width="${round(element.w)}" height="${round(element.h)}" `
        + `viewBox="0 0 100 100" preserveAspectRatio="none" overflow="visible">`
        + shapePath(element.shape, fill, element.stroke ? escape(element.stroke) : null, element.strokeWidth ?? 2, element.path) + '</svg>');
      continue;
    }

    if (element.kind === 'table') {
      const look = textLook(element, model);
      const size = Math.min(look.size, element.h / Math.max(element.rows, 1) * 0.5);
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
          + `fill="${escape(look.color)}"`
          + `${element.header && r === 0 ? ' font-weight="700"' : ''}>`
          + `${escape(cell)}</text>`);
      }));
      continue;
    }

    if (element.kind === 'line') {
      const stroke = escape(element.fill ?? model.theme.accent ?? '#1f6feb');
      const [x1, y1, x2, y2] = lineEnds(element);
      parts.push(`<line x1="${round(x1)}" y1="${round(y1)}" `
        + `x2="${round(x2)}" y2="${round(y2)}" `
        + `stroke="${stroke}" stroke-width="${element.thickness ?? 4}"/>`);
      continue;
    }

    if (element.kind !== 'text') continue;

    const look = textLook(element, model);
    const { size } = look;
    const lines = wrapText(SlidesModel.plainText(element), element.w, size);
    const top = textTop(element, look, lines.length);
    const anchor = { left: 'start', center: 'middle', right: 'end' }[look.align] ?? 'start';
    const x = look.align === 'center' ? element.x + element.w / 2 : look.align === 'right' ? element.x + element.w : element.x;

    lines.forEach((line, i) => {
      const family = look.font === 'serif' ? 'serif' : look.font === 'mono' ? 'monospace' : 'sans-serif';
      parts.push(`<text x="${round(x)}" y="${round(top + size * (1 + i * 1.25))}" text-anchor="${anchor}" `
        + `font-family="${family}" font-size="${size}" `
        + `fill="${escape(look.color)}"`
        + `${look.bold ? ' font-weight="700"' : ''}${look.italic ? ' font-style="italic"' : ''}>${escape(line)}</text>`);
    });
  }

  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

/** Where a box's text begins, anchored at the top, middle or bottom. */
function textTop(element, look, lineCount) {
  const height = lineCount * look.size * 1.25;
  if (look.valign === 'middle') return element.y + (element.h - height) / 2;
  if (look.valign === 'bottom') return element.y + element.h - height;
  return element.y;
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
      const fill = shapeFill(element, model);
      primitives.push({
        type: 'path', d: shapeOutlineOnPage(element), fill: fill === 'none' ? null : fill,
        ...(element.stroke ? { stroke: element.stroke, strokeWidth: element.strokeWidth ?? 2 } : {}),
      });
      continue;
    }

    if (element.kind === 'table') {
      const look = textLook(element, model);
      const cw = element.w / element.cols;
      const ch = element.h / element.rows;
      const size = Math.min(look.size, ch * 0.45);

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
          fill: look.color,
          bold: element.header && r === 0,
        });
      }));
      continue;
    }

    if (element.kind === 'line') {
      const [x1, y1, x2, y2] = lineEnds(element);
      primitives.push({
        type: 'polyline',
        points: [[x1, y1], [x2, y2]],
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

    const look = textLook(element, model);
    const { size } = look;
    const lines = wrapText(SlidesModel.plainText(element), element.w, size);
    const top = textTop(element, look, lines.length);

    lines.forEach((line, i) => {
      primitives.push({
        type: 'text',
        x: look.align === 'center' ? element.x + element.w / 2 : look.align === 'right' ? element.x + element.w : element.x,
        y: top + i * size * 1.25,
        text: line,
        size,
        align: look.align === 'center' || look.align === 'right' ? look.align : 'left',
        bold: look.bold,
        italic: look.italic,
        fill: look.color,
      });
    });
  }

  return { width: w, height: h, primitives };
}

/** A shape's outline where it sits on the slide, turned as it is turned. */
export function shapeOutlineOnPage(element) {
  const { x, y, w, h } = element;
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return formatPath(mapPath(parsePath(presetOutline(element.shape, element.path)), (px, py) => {
    const ax = x + (px / 100) * w - cx;
    const ay = y + (py / 100) * h - cy;
    return [cx + ax * Math.cos(angle) - ay * Math.sin(angle), cy + ax * Math.sin(angle) + ay * Math.cos(angle)];
  }), 2);
}
