/** Text recognised in pictures of pages, by Tesseract running here: nothing leaves the computer, nothing is kept after. */

/** The languages Read carries, by Tesseract's names. */
export const OCR_LANGUAGES = { ita: 'Italiano', eng: 'English' };

const vendor = new URL('../vendor/tesseract/', import.meta.url).href;
let library = null;

/**
 * A recogniser for some languages; close it when done.
 * @param {string[]} languages
 * @param {(progress: number) => void} onProgress
 */
export async function recogniser(languages, onProgress = () => {}) {
  library ??= await import('../vendor/tesseract/tesseract.esm.js');
  const create = library.createWorker ?? library.default?.createWorker;
  return create(languages.join('+'), 1, {
    workerPath: `${vendor}worker.js`,
    corePath: vendor,
    langPath: vendor.replace(/\/$/, ''),
    gzip: false,
    // A worker from the program's own file, and no copy of the language data stored in the browser's database.
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
}

/**
 * The words of one page picture, each with its box as fractions of the page.
 * @param {Object} worker from recogniser()
 * @param {HTMLCanvasElement} canvas the page drawn at a good resolution
 * @returns {Promise<{text: string, x: number, y: number, w: number, h: number}[]>}
 */
export async function wordsOf(worker, canvas) {
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
  const words = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = String(word.text ?? '').trim();
          if (!text || word.confidence < 30) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          words.push({
            text: text.slice(0, 200),
            x: x0 / canvas.width, y: y0 / canvas.height, w: (x1 - x0) / canvas.width, h: (y1 - y0) / canvas.height,
          });
          if (words.length >= 20000) return words;
        }
      }
    }
  }
  return words;
}
