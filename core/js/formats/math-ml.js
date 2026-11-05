/** Formulas in files: MathML objects for OpenDocument, Office Math (OMML) for Word, and back. */

import { kids, kid, tag, xmlDocument, escapeText } from '../xml.js';

export const MATHML = 'http://www.w3.org/1998/Math/MathML';
export const OMML = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const FORMULA_MIMETYPE = 'application/vnd.oasis.opendocument.formula';
const MAX_NODES = 20000;

/**
 * MathML parsed and written again: well formed, MathML elements only, no attribute that could run or fetch anything.
 * @returns {?Element} the math element
 */
export function safeMath(mathml) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(mathml ?? ''), 'application/xml');
  } catch {
    return null;
  }
  const math = doc.documentElement;
  if (!math || math.localName !== 'math' || math.namespaceURI !== MATHML || doc.getElementsByTagName('parsererror').length) return null;
  let count = 0;
  for (const element of [math, ...math.getElementsByTagName('*')]) {
    if (element !== math && ((count += 1) > MAX_NODES || element.namespaceURI !== MATHML)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (/^(on|xlink:|href|src)/i.test(attribute.name) || attribute.namespaceURI && attribute.namespaceURI !== MATHML) element.removeAttribute(attribute.name);
    }
  }
  return math;
}

/** The MathML a formula object carries, its math element's inside only. */
function innerOf(mathml) {
  const math = safeMath(mathml);
  return math ? [...math.childNodes].map((node) => new XMLSerializer().serializeToString(node)).join('').replace(/ xmlns="[^"]*"/g, '') : '';
}

/** A MathML string with its TeX kept beside it, as an annotation Paper reads back. */
export function mathmlWithTex(object) {
  const inner = innerOf(object.mathml) || (object.tex ? `<mtext>${escapeText(object.tex)}</mtext>` : '<mrow/>');
  const body = /^\s*<semantics>/.test(inner) ? inner.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/^\s*<semantics>|<\/semantics>\s*$/g, '') : inner;
  const annotation = object.tex ? `<annotation encoding="TeX">${escapeText(object.tex)}</annotation>` : '';
  return `<math xmlns="${MATHML}"${object.display ? ' display="block"' : ''}><semantics><mrow>${body}</mrow>${annotation}</semantics></math>`;
}

/** The content of a formula object, as LibreOffice Math opens it. */
export function odfFormulaXml(object) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${mathmlWithTex(object)}`;
}

/** A formula read back from a MathML element: its TeX when it kept it, and the MathML without the annotations. */
export function readMathElement(math) {
  if (!math || math.localName !== 'math') return null;
  let tex = null;
  for (const annotation of math.getElementsByTagNameNS(MATHML, 'annotation')) {
    if (/^(TeX|LaTeX|application\/x-tex)$/i.test(annotation.getAttribute('encoding') ?? '')) tex = annotation.textContent;
  }
  const clone = math.cloneNode(true);
  for (const annotation of [...clone.getElementsByTagNameNS(MATHML, 'annotation'), ...clone.getElementsByTagNameNS(MATHML, 'annotation-xml')]) annotation.remove();
  const cleaned = safeMath(new XMLSerializer().serializeToString(clone));
  const serial = cleaned ? new XMLSerializer().serializeToString(cleaned) : '';
  const mathml = serial && serial.length <= 100000 ? serial : null;
  if (!tex && !mathml) return null;
  return { type: 'math', ...(tex ? { tex } : {}), ...(mathml ? { mathml } : {}), ...(math.getAttribute('display') === 'block' ? { display: true } : {}) };
}

// MathML to Office Math

const OMML_OF = {
  mfrac: (c) => tag('m:f', {}, tag('m:num', {}, c[0]), tag('m:den', {}, c[1])),
  msup: (c) => tag('m:sSup', {}, tag('m:e', {}, c[0]), tag('m:sup', {}, c[1])),
  msub: (c) => tag('m:sSub', {}, tag('m:e', {}, c[0]), tag('m:sub', {}, c[1])),
  msubsup: (c) => tag('m:sSubSup', {}, tag('m:e', {}, c[0]), tag('m:sub', {}, c[1]), tag('m:sup', {}, c[2])),
  msqrt: (c) => tag('m:rad', {}, tag('m:radPr', {}, tag('m:degHide', { 'm:val': '1' })), tag('m:deg', {}), tag('m:e', {}, c)),
  mroot: (c) => tag('m:rad', {}, tag('m:deg', {}, c[1]), tag('m:e', {}, c[0])),
  munder: (c) => tag('m:limLow', {}, tag('m:e', {}, c[0]), tag('m:lim', {}, c[1])),
  mover: (c) => tag('m:limUpp', {}, tag('m:e', {}, c[0]), tag('m:lim', {}, c[1])),
  munderover: (c) => tag('m:nary', {}, tag('m:naryPr', {}, tag('m:chr', { 'm:val': '' }), tag('m:limLoc', { 'm:val': 'undOvr' })), tag('m:sub', {}, c[1]), tag('m:sup', {}, c[2]), tag('m:e', {}, c[0])),
};

/** One MathML element as Office Math runs and structures. */
function ommlOf(element, budget) {
  if (budget.left-- <= 0) return [];
  const children = () => kids(element).map((child) => ommlOf(child, budget));
  const run = (text, plain = false) => tag('m:r', {}, plain ? tag('m:rPr', {}, tag('m:sty', { 'm:val': 'p' })) : null, tag('m:t', { 'xml:space': 'preserve' }, text));
  switch (element.localName) {
    case 'mi': return [run(element.textContent, element.textContent.length > 1 || element.getAttribute('mathvariant') === 'normal')];
    case 'mn': case 'mo': case 'mtext': case 'ms': return [run(element.textContent, true)];
    case 'mspace': return [run(' ', true)];
    case 'mfrac': case 'msup': case 'msub': case 'msubsup': case 'mroot': case 'munder': case 'mover': {
      const c = children();
      return [OMML_OF[element.localName](c)];
    }
    case 'munderover': {
      // A big operator with limits, such as a sum, is an n-ary in Word; anything else keeps the limits.
      const [base, under, over] = kids(element);
      if (base?.localName === 'mo') {
        return [tag('m:nary', {}, tag('m:naryPr', {}, tag('m:chr', { 'm:val': base.textContent }), tag('m:limLoc', { 'm:val': 'undOvr' })),
          tag('m:sub', {}, ommlOf(under, budget)), tag('m:sup', {}, ommlOf(over, budget)), tag('m:e', {}))];
      }
      const c = children();
      return [tag('m:limUpp', {}, tag('m:e', {}, tag('m:limLow', {}, tag('m:e', {}, c[0]), tag('m:lim', {}, c[1]))), tag('m:lim', {}, c[2]))];
    }
    case 'msqrt': return [OMML_OF.msqrt(children())];
    case 'mfenced': return [tag('m:d', {}, tag('m:dPr', {}, tag('m:begChr', { 'm:val': element.getAttribute('open') ?? '(' }), tag('m:endChr', { 'm:val': element.getAttribute('close') ?? ')' })), tag('m:e', {}, children()))];
    case 'mtable': return [tag('m:m', {}, kids(element).map((row) => tag('m:mr', {}, kids(row).map((cell) => tag('m:e', {}, ommlOf(cell, budget))))))];
    case 'annotation': case 'annotation-xml': return [];
    default: return children();
  }
}

/** A MathML string as an Office Math element; null when it does not parse. */
export function mathmlToOmml(mathml, display = false) {
  const math = safeMath(mathml);
  if (!math) return null;
  const body = tag('m:oMath', {}, ommlOf(math, { left: MAX_NODES }));
  return display ? tag('m:oMathPara', {}, body) : body;
}

// Office Math to MathML

const esc = (text) => escapeText(text ?? '');

function mathmlOf(element, budget) {
  if (!element || budget.left-- <= 0) return '';
  const all = (parent) => kids(parent).map((child) => mathmlOf(child, budget)).join('');
  const part = (name) => `<mrow>${all(kid(element, OMML, name))}</mrow>`;
  switch (element.localName) {
    case 'r': {
      const text = [...element.getElementsByTagNameNS(OMML, 't')].map((t) => t.textContent).join('');
      const plain = kid(kid(element, OMML, 'rPr'), OMML, 'sty')?.getAttribute('m:val') === 'p'
        || kid(kid(element, OMML, 'rPr'), OMML, 'sty')?.getAttributeNS(OMML, 'val') === 'p';
      return [...text].map((ch) => (/\d/.test(ch) ? `<mn>${esc(ch)}</mn>` : /[A-Za-zͰ-Ͽ]/.test(ch) ? (plain ? `<mi mathvariant="normal">${esc(ch)}</mi>` : `<mi>${esc(ch)}</mi>`) : `<mo>${esc(ch)}</mo>`)).join('');
    }
    case 'f': return `<mfrac>${part('num')}${part('den')}</mfrac>`;
    case 'sSup': return `<msup>${part('e')}${part('sup')}</msup>`;
    case 'sSub': return `<msub>${part('e')}${part('sub')}</msub>`;
    case 'sSubSup': return `<msubsup>${part('e')}${part('sub')}${part('sup')}</msubsup>`;
    case 'rad': {
      const degree = kid(element, OMML, 'deg');
      return degree && kids(degree).length ? `<mroot>${part('e')}${part('deg')}</mroot>` : `<msqrt>${all(kid(element, OMML, 'e'))}</msqrt>`;
    }
    case 'limLow': return `<munder>${part('e')}${part('lim')}</munder>`;
    case 'limUpp': return `<mover>${part('e')}${part('lim')}</mover>`;
    case 'nary': {
      const chr = kid(kid(element, OMML, 'naryPr'), OMML, 'chr');
      const symbol = chr?.getAttributeNS(OMML, 'val') ?? chr?.getAttribute('m:val') ?? '∫';
      return `<mrow><munderover><mo>${esc(symbol)}</mo>${part('sub')}${part('sup')}</munderover>${part('e')}</mrow>`;
    }
    case 'd': {
      const pr = kid(element, OMML, 'dPr');
      const open = kid(pr, OMML, 'begChr')?.getAttributeNS(OMML, 'val') ?? '(';
      const close = kid(pr, OMML, 'endChr')?.getAttributeNS(OMML, 'val') ?? ')';
      return `<mrow><mo>${esc(open)}</mo>${kids(element, OMML, 'e').map((e) => all(e)).join('<mo>,</mo>')}<mo>${esc(close)}</mo></mrow>`;
    }
    case 'm': return `<mtable>${kids(element, OMML, 'mr').map((row) => `<mtr>${kids(row, OMML, 'e').map((e) => `<mtd>${all(e)}</mtd>`).join('')}</mtr>`).join('')}</mtable>`;
    case 'rPr': case 'ctrlPr': case 'fPr': case 'radPr': case 'naryPr': case 'dPr': case 'sSupPr': case 'sSubPr': case 'sSubSupPr': case 'limLowPr': case 'limUppPr': case 'mPr': case 'oMathParaPr':
      return '';
    default: return all(element);
  }
}

/** An Office Math element read back as a formula object. */
export function readOmml(element) {
  const display = element.localName === 'oMathPara';
  const body = mathmlOf(element, { left: MAX_NODES });
  if (!body) return null;
  return { type: 'math', mathml: `<math xmlns="${MATHML}"${display ? ' display="block"' : ''}><mrow>${body}</mrow></math>`, ...(display ? { display: true } : {}) };
}

// Formula files: MathML on its own (.mml), and LibreOffice Math's documents (.odf).

/** A formula file read: the text of a .mml, or the content.xml of a .odf; null when no formula is in it. */
export function readFormulaFile(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(text ?? ''), 'application/xml');
  } catch {
    return null;
  }
  if (doc.getElementsByTagName('parsererror').length) return null;
  const math = doc.documentElement?.localName === 'math' ? doc.documentElement : doc.getElementsByTagNameNS(MATHML, 'math')[0];
  const object = readMathElement(math);
  return object ? { ...object, display: true } : null;
}

/** The entries of a .odf formula document, as LibreOffice Math writes one. */
export function formulaPackage(object) {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${FORMULA_MIMETYPE}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return [
    { name: 'mimetype', data: FORMULA_MIMETYPE, store: true },
    { name: 'content.xml', data: odfFormulaXml(object) },
    { name: 'META-INF/manifest.xml', data: manifest },
  ];
}

export { xmlDocument };
