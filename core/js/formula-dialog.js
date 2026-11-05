/** The formula dialog every program shares: TeX typed or built from elements, the formula drawn as it is typed. */

import { loadMath, mathSvg, texToMathml, texError } from './math.js';
import { safeMath } from './formats/math-ml.js';
import { showPanel, readFields, escapeHtml } from './panel.js';

/** A place still to fill in an element, as LibreOffice Math marks it. */
export const MARKER = '<?>';

/** The elements offered, as LibreOffice Math groups them; each is TeX with markers where something goes. */
export const ELEMENTS = {
  'Operators': [['a + b', '<?> + <?>'], ['a − b', '<?> - <?>'], ['a · b', '<?> \\cdot <?>'], ['a × b', '<?> \\times <?>'], ['a ÷ b', '<?> \\div <?>'], ['a/b', '\\frac{<?>}{<?>}'], ['√a', '\\sqrt{<?>}'], ['ⁿ√a', '\\sqrt[<?>]{<?>}'], ['aⁿ', '{<?>}^{<?>}'], ['aₙ', '{<?>}_{<?>}'], ['±', '\\pm']],
  'Relations': [['=', '<?> = <?>'], ['≠', '<?> \\neq <?>'], ['≈', '<?> \\approx <?>'], ['<', '<?> < <?>'], ['≤', '<?> \\leq <?>'], ['>', '<?> > <?>'], ['≥', '<?> \\geq <?>'], ['≡', '<?> \\equiv <?>'], ['∝', '<?> \\propto <?>'], ['→', '<?> \\to <?>']],
  'Functions': [['sin', '\\sin(<?>)'], ['cos', '\\cos(<?>)'], ['tan', '\\tan(<?>)'], ['ln', '\\ln(<?>)'], ['log', '\\log_{<?>}(<?>)'], ['exp', 'e^{<?>}'], ['|a|', '\\left|<?>\\right|'], ['n!', '<?>!']],
  'Big operators': [['Σ', '\\sum_{<?>}^{<?>} <?>'], ['Π', '\\prod_{<?>}^{<?>} <?>'], ['∫', '\\int_{<?>}^{<?>} <?> \\, d<?>'], ['∬', '\\iint <?>'], ['∮', '\\oint <?>'], ['lim', '\\lim_{<?> \\to <?>} <?>']],
  'Brackets': [['( )', '\\left( <?> \\right)'], ['[ ]', '\\left[ <?> \\right]'], ['{ }', '\\left\\{ <?> \\right\\}'], ['⟨ ⟩', '\\langle <?> \\rangle'], ['⌊ ⌋', '\\lfloor <?> \\rfloor']],
  'Sets': [['∈', '<?> \\in <?>'], ['∉', '<?> \\notin <?>'], ['⊂', '<?> \\subset <?>'], ['∪', '<?> \\cup <?>'], ['∩', '<?> \\cap <?>'], ['∅', '\\emptyset'], ['ℕ', '\\mathbb{N}'], ['ℤ', '\\mathbb{Z}'], ['ℝ', '\\mathbb{R}'], ['ℂ', '\\mathbb{C}']],
  'Formats': [['matrix', '\\begin{pmatrix} <?> & <?> \\\\ <?> & <?> \\end{pmatrix}'], ['cases', '\\begin{cases} <?> & <?> \\\\ <?> & <?> \\end{cases}'], ['bold', '\\mathbf{<?>}'], ['text', '\\text{<?>}'], ['vector', '\\vec{<?>}'], ['bar', '\\overline{<?>}'], ['hat', '\\hat{<?>}']],
};

/** Symbols, by the name LibreOffice Math's catalogue gives the set. */
export const SYMBOLS = {
  'Greek': ['\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\zeta', '\\eta', '\\theta', '\\lambda', '\\mu', '\\pi', '\\rho', '\\sigma', '\\tau', '\\phi', '\\chi', '\\psi', '\\omega', '\\Gamma', '\\Delta', '\\Theta', '\\Lambda', '\\Pi', '\\Sigma', '\\Phi', '\\Psi', '\\Omega'],
  'Special': ['\\infty', '\\partial', '\\nabla', '\\forall', '\\exists', '\\neg', '\\wedge', '\\vee', '\\Rightarrow', '\\Leftrightarrow', '\\hbar', '\\ell', '\\aleph', '\\degree', '\\dots', '\\cdots'],
};

/** Where the next marker is after a position, or the previous one before it; null when there is none. */
export function findMarker(text, from, backward = false) {
  if (backward) {
    const at = from - MARKER.length < 0 ? -1 : text.lastIndexOf(MARKER, from - MARKER.length);
    return at === -1 || at >= from ? null : at;
  }
  const at = text.indexOf(MARKER, from);
  return at === -1 ? null : at;
}

/** Where a TeX error is, from the engine's message: the command it does not know, or the start. */
export function errorPosition(tex, message) {
  const command = /\\[A-Za-z]+/.exec(String(message ?? ''))?.[0];
  if (command) {
    const at = tex.indexOf(command);
    if (at !== -1) return { start: at, end: at + command.length };
  }
  return { start: 0, end: 0 };
}

const visible = (tex) => tex.split(MARKER).join('\\square');

/** The formula dialog, the formula drawn as its TeX is typed; null when nothing is to change. */
export async function formulaDialog(object = {}) {
  loadMath().catch(() => {});
  const groups = Object.entries(ELEMENTS).map(([group, items]) => `
    <details class="formula-group"><summary>${escapeHtml(group)}</summary>${items.map(([label, tex]) => `<button type="button" data-tex="${escapeHtml(tex)}">${escapeHtml(label)}</button>`).join('')}</details>`).join('');
  const symbols = Object.entries(SYMBOLS).map(([group, items]) => `
    <details class="formula-group"><summary>${escapeHtml(group)}</summary>${items.map((tex) => `<button type="button" data-tex="${escapeHtml(tex)} " title="${escapeHtml(tex)}">${escapeHtml(tex)}</button>`).join('')}</details>`).join('');
  const answer = showPanel('Formula', `
    <div class="formula-preview" id="formula-preview"></div>
    <p class="hint" id="formula-error" role="status"></p>
    <label>TeX<textarea data-field="tex" rows="4" spellcheck="false" data-enter-confirms placeholder="\\\\int_0^1 x^2 \\\\, dx">${escapeHtml(object.tex ?? '')}</textarea></label>
    <div class="formula-elements" aria-label="Elements">${groups}${symbols}</div>
    <div class="row">
      <button type="button" data-formula="previous" title="Previous place to fill (Shift+F4)">◀ Place</button>
      <button type="button" data-formula="next" title="Next place to fill (F4)">Place ▶</button>
      <button type="button" data-formula="error" title="Go to the error">Error</button>
      <button type="button" data-formula="mathml" title="Formula copied from another program as MathML">Paste MathML</button>
    </div>
    <label class="inline"><input type="checkbox" data-field="display"${object.display ? ' checked' : ''}> On a line of its own ($$)</label>`, 'Apply');
  const body = document.getElementById('panel-body');
  const area = body.querySelector('[data-field="tex"]');
  let pasted = null;
  const preview = () => {
    const node = document.getElementById('formula-preview');
    const tex = area.value.trim();
    if (!node) return;
    const svg = tex ? mathSvg({ tex: visible(tex), display: true }) : pasted ? mathSvg({ mathml: pasted, display: true }) : '';
    node.innerHTML = svg ?? '';
    const error = tex ? texError(visible(tex)) : null;
    document.getElementById('formula-error').textContent = error ? `This TeX does not make a formula yet: ${error}` : '';
  };
  const select = (start, end) => {
    area.focus();
    area.setSelectionRange(start, end);
  };
  const jump = (backward) => {
    const at = findMarker(area.value, backward ? area.selectionStart : area.selectionEnd, backward);
    if (at !== null) select(at, at + MARKER.length);
  };
  const insert = (tex) => {
    const { selectionStart: a, selectionEnd: b, value } = area;
    area.value = value.slice(0, a) + tex + value.slice(b);
    const marker = findMarker(area.value, a);
    if (marker !== null && marker < a + tex.length) select(marker, marker + MARKER.length);
    else select(a + tex.length, a + tex.length);
    preview();
  };
  body.addEventListener('click', async (event) => {
    const element = event.target.closest('[data-tex]');
    if (element) {
      insert(element.dataset.tex);
      return;
    }
    const action = event.target.closest('[data-formula]')?.dataset.formula;
    if (action === 'next' || action === 'previous') jump(action === 'previous');
    else if (action === 'error') {
      const { start, end } = errorPosition(area.value, texError(visible(area.value)));
      select(start, end);
    } else if (action === 'mathml') {
      const text = await navigator.clipboard?.readText?.().catch(() => '') ?? '';
      const math = safeMath(text);
      if (!math) {
        document.getElementById('formula-error').textContent = 'There is no MathML in the clipboard';
        return;
      }
      pasted = new XMLSerializer().serializeToString(math);
      area.value = '';
      preview();
    }
  });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'F4') {
      event.preventDefault();
      jump(event.shiftKey);
    }
  });
  body.addEventListener('input', () => {
    pasted = null;
    preview();
  });
  loadMath().then(preview, () => {});
  preview();
  const confirmed = await answer;
  const f = readFields();
  if (!confirmed) return null;
  if (pasted && !f.tex.trim()) return { type: 'math', mathml: pasted, ...(f.display ? { display: true } : {}) };
  if (!f.tex.trim()) return null;
  // A place left unfilled is kept as an empty box, which every program draws.
  const tex = visible(f.tex.trim());
  const mathml = texToMathml(tex, f.display);
  return { type: 'math', tex, ...(f.display ? { display: true } : {}), ...(mathml ? { mathml } : {}) };
}
