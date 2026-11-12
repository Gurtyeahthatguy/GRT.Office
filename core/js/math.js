/** Formulas: TeX or MathML in, SVG out, by MathJax, loaded the first time a formula is shown and never from the network. */

let loading = null;
/** Whether MathJax has finished starting, after which it may load nothing but parts of its font. */
let started = false;
const drawn = new Map();
const listeners = new Set();

/** The largest formula taken, so a hostile file cannot keep the layout busy. */
export const MAX_TEX = 5000;
export const MAX_MATHML = 100000;

/**
 * Loads MathJax from the program's own files. TeX packages that would fetch more of themselves are left out,
 * and the font's rarer parts come only from the program's folder, so nothing is ever asked of the network;
 * the content security policy would refuse it anyway.
 */
export function loadMath(url = new URL('../../vendor/mathjax-tex-mml-svg.js', import.meta.url).href) {
  if (loading) return loading;
  const base = new URL('../../vendor', import.meta.url).href;
  loading = new Promise((resolve, reject) => {
    window.MathJax = {
      loader: {
        load: [],
        paths: { mathjax: base, fonts: base },
        // Any other file asked for is refused before its address is made.
        // Run last, on the address a name has become. While starting, MathJax names its own parts, all inside the file,
        // and only addresses in the program's own folder pass; once started, only the font's rarer parts may load.
        pathFilters: [[(data) => {
          const name = String(data.name);
          const fontPart = name.startsWith(`${base}/mathjax-newcm-font/svg/dynamic/`) && !name.includes('..');
          if (!name.startsWith(`${base}/`) || (started && !fontPart)) throw new Error(`MathJax may not load ${data.original ?? name}`);
          return true;
        }, 1000]],
      },
      startup: { typeset: false, pageReady: () => Promise.resolve() },
      tex: { packages: { '[-]': ['autoload', 'require', 'noundefined'] }, maxBuffer: 20 * 1024, maxMacros: 1000 },
      svg: { fontCache: 'none' },
      options: {
        enableMenu: false, enableAssistiveMml: false, enableEnrichment: false, enableSpeech: false,
        enableBraille: false, enableExplorer: false, enableExplorerHelp: false, enableComplexity: false,
        // The menu's own settings would turn speech back on, and with it a worker that loads more of MathJax.
        menuOptions: { settings: { enrich: false, speech: false, braille: false, collapsible: false, assistiveMml: false, inTabOrder: false } },
      },
    };
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => window.MathJax.startup.promise.then(() => { started = true; resolve(window.MathJax); }, reject);
    script.onerror = () => reject(new Error('The formula engine could not be loaded'));
    document.head.append(script);
  }).then((mathjax) => {
    for (const listener of listeners) listener();
    return mathjax;
  });
  return loading;
}

/** Calls back once the engine is there, so what was drawn as a placeholder can be drawn again. */
export function whenMathReady(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const mathReady = () => !!window.MathJax?.tex2svg;

const keyOf = (object) => JSON.stringify([object.tex ?? null, object.tex ? null : object.mathml ?? null, !!object.display]);

/** A formula as SVG markup, or null until the engine has loaded; loading starts here. */
export function mathSvg(object) {
  const key = keyOf(object);
  if (drawn.has(key)) return drawn.get(key);
  if (!mathReady()) {
    loadMath().catch(() => {});
    return null;
  }
  const options = { display: !!object.display };
  const source = object.tex ? String(object.tex).slice(0, MAX_TEX) : String(object.mathml ?? '').slice(0, MAX_MATHML);
  try {
    return remember(key, svgOf(object.tex ? window.MathJax.tex2svg(source, options) : window.MathJax.mathml2svg(source, options)));
  } catch (error) {
    // A character in a rarer part of the font: that part is loaded, then the formula is drawn again.
    if (error?.retry) {
      const later = object.tex ? window.MathJax.tex2svgPromise(source, options) : window.MathJax.mathml2svgPromise(source, options);
      later.then((node) => remember(key, svgOf(node)), () => remember(key, null)).then(() => { for (const listener of listeners) listener(); });
      return null;
    }
    return remember(key, null);
  }
}

/** The SVG of a node MathJax made; null for a formula that does not parse, which then shows its source, marked. */
function svgOf(node) {
  const element = node?.querySelector('svg');
  if (!element || node.querySelector('[data-mjx-error]')) return null;
  element.removeAttribute('focusable');
  return element.outerHTML;
}

function remember(key, svg) {
  const result = svg ?? '';
  if (drawn.size > 2000) drawn.clear();
  drawn.set(key, result);
  return result;
}

/** What is wrong with a TeX formula, as the engine says it; null when it parses or the engine is not there. */
export function texError(tex) {
  if (!mathReady() || !String(tex ?? '').trim()) return null;
  try {
    const node = window.MathJax.tex2svg(String(tex).slice(0, MAX_TEX), { display: true });
    const error = node.querySelector('[data-mjx-error]');
    return error ? error.getAttribute('data-mjx-error') || error.textContent || 'This TeX does not parse' : null;
  } catch (thrown) {
    // A part of the font still loading says nothing about the TeX.
    if (thrown?.retry) return null;
    return String(thrown?.message ?? thrown);
  }
}

/** MathML for a TeX formula, for the files; null when the engine is not there or the TeX does not parse. */
export function texToMathml(tex, display = false) {
  if (!mathReady()) return null;
  try {
    const mathml = window.MathJax.tex2mml(String(tex).slice(0, MAX_TEX), { display });
    return /merror/.test(mathml) ? null : mathml;
  } catch {
    return null;
  }
}
