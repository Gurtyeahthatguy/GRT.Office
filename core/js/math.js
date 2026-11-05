/** Formulas: TeX or MathML in, SVG out, by MathJax, loaded the first time a formula is shown and never from the network. */

let loading = null;
const drawn = new Map();
const listeners = new Set();

/** The largest formula taken, so a hostile file cannot keep the layout busy. */
export const MAX_TEX = 5000;
export const MAX_MATHML = 100000;

/**
 * Loads MathJax from the program's own files. Packages that would fetch more of themselves are left out,
 * so nothing is ever asked of the network, and the content security policy would refuse it anyway.
 */
export function loadMath(url = new URL('../../vendor/mathjax-tex-mml-svg.js', import.meta.url).href) {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.MathJax = {
      loader: { load: [], require: () => Promise.reject(new Error('MathJax may not load more of itself')) },
      startup: { typeset: false, pageReady: () => Promise.resolve() },
      tex: { packages: { '[-]': ['autoload', 'require', 'noundefined'] }, maxBuffer: 20 * 1024, maxMacros: 1000 },
      svg: { fontCache: 'none' },
      options: { enableMenu: false, enableAssistiveMml: false },
    };
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => window.MathJax.startup.promise.then(() => resolve(window.MathJax), reject);
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
  let svg;
  try {
    const node = object.tex
      ? window.MathJax.tex2svg(String(object.tex).slice(0, MAX_TEX), { display: !!object.display })
      : window.MathJax.mathml2svg(String(object.mathml ?? '').slice(0, MAX_MATHML), { display: !!object.display });
    const element = node.querySelector('svg');
    // A formula that does not parse shows its source, marked, rather than nothing.
    if (!element || node.querySelector('[data-mjx-error]')) svg = null;
    else {
      element.removeAttribute('focusable');
      svg = element.outerHTML;
    }
  } catch {
    svg = null;
  }
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
