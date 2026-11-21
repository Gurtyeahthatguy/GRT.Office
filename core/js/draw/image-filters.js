/** Draw's image filters, on pixels; each makes a new picture, as LibreOffice's do, and never touches the one it read. */

const MAX_PIXELS = 40e6;

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function copy(img) {
  if (img.width * img.height > MAX_PIXELS) throw new Error('The image is too large to filter');
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** A 3 by 3 convolution, the edge pixels taking their nearest neighbours. */
function convolve(img, kernel, divisor = 1, offset = 0, keepAlpha = true) {
  const out = copy(img);
  const { width: w, height: h, data } = img;
  const at = (x, y) => ((Math.min(h - 1, Math.max(0, y)) * w) + Math.min(w - 1, Math.max(0, x))) * 4;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky += 1) for (let kx = -1; kx <= 1; kx += 1) sum += data[at(x + kx, y + ky) + c] * kernel[(ky + 1) * 3 + kx + 1];
        out.data[i + c] = clamp(sum / divisor + offset);
      }
      if (!keepAlpha) out.data[i + 3] = 255;
    }
  }
  return out;
}

const grey = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export const FILTERS = {
  /** Invert: every colour turned to its opposite. */
  invert(img) {
    const out = copy(img);
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c += 1) out.data[i + c] = 255 - out.data[i + c];
    return out;
  },
  /** Posterize: so many levels of each colour. */
  posterize(img, { levels = 4 } = {}) {
    const out = copy(img);
    const n = Math.max(2, Math.min(64, Math.floor(levels)));
    const step = 255 / (n - 1);
    for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c += 1) out.data[i + c] = Math.round(Math.round(out.data[i + c] / step) * step);
    return out;
  },
  /** Solarization: colours past a threshold turned over. */
  solarize(img, { threshold = 128, invert = false } = {}) {
    const out = copy(img);
    for (let i = 0; i < out.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const v = out.data[i + c];
        let s = v >= threshold ? 255 - v : v;
        if (invert) s = 255 - s;
        out.data[i + c] = s;
      }
    }
    return out;
  },
  /** Mosaic: tiles of one colour each, the average of what they cover. */
  mosaic(img, { tile = 8 } = {}) {
    const out = copy(img);
    const t = Math.max(2, Math.min(256, Math.floor(tile)));
    const { width: w, height: h } = img;
    for (let ty = 0; ty < h; ty += t) {
      for (let tx = 0; tx < w; tx += t) {
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = ty; y < Math.min(h, ty + t); y += 1) for (let x = tx; x < Math.min(w, tx + t); x += 1) { const i = (y * w + x) * 4; sum[0] += img.data[i]; sum[1] += img.data[i + 1]; sum[2] += img.data[i + 2]; n += 1; }
        for (let y = ty; y < Math.min(h, ty + t); y += 1) for (let x = tx; x < Math.min(w, tx + t); x += 1) { const i = (y * w + x) * 4; for (let c = 0; c < 3; c += 1) out.data[i + c] = sum[c] / n; }
      }
    }
    return out;
  },
  /** Relief: an embossed grey picture, lit from the upper left. */
  relief(img) {
    const out = convolve(img, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 0);
    for (let i = 0; i < out.data.length; i += 4) { const g = grey(out.data, i); out.data[i] = out.data[i + 1] = out.data[i + 2] = clamp(g * 0.6 + 64); }
    return out;
  },
  /** Sharpen. */
  sharpen(img) { return convolve(img, [0, -1, 0, -1, 5, -1, 0, -1, 0]); },
  /** Smooth: a soft blur. */
  smooth(img, { passes = 1 } = {}) {
    let out = img;
    for (let k = 0; k < Math.max(1, Math.min(10, passes)); k += 1) out = convolve(out, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16);
    return out === img ? copy(img) : out;
  },
  /** Remove Noise: each pixel the median of its neighbours. */
  removeNoise(img) {
    const out = copy(img);
    const { width: w, height: h, data } = img;
    const vals = new Array(9);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          let k = 0;
          for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) vals[k++] = data[((Math.min(h - 1, Math.max(0, y + dy)) * w) + Math.min(w - 1, Math.max(0, x + dx))) * 4 + c];
          vals.sort((a, b) => a - b);
          out.data[(y * w + x) * 4 + c] = vals[4];
        }
      }
    }
    return out;
  },
  /** Aging: brown and darker, as an old photograph. */
  aging(img, { degree = 10 } = {}) {
    const out = copy(img);
    const d = Math.max(0, Math.min(100, degree)) / 100;
    for (let i = 0; i < out.data.length; i += 4) {
      const g = grey(out.data, i) * (1 - d * 0.3);
      out.data[i] = clamp(g * 1.07 + 20 * d);
      out.data[i + 1] = clamp(g * 0.95 + 5 * d);
      out.data[i + 2] = clamp(g * 0.75);
    }
    return out;
  },
  /** Charcoal Sketch: the edges of the picture drawn dark on white. */
  charcoal(img) {
    const edges = convolve(img, [-1, -1, -1, -1, 8, -1, -1, -1, -1]);
    const out = copy(img);
    for (let i = 0; i < out.data.length; i += 4) { const v = clamp(255 - grey(edges.data, i) * 1.5); out.data[i] = out.data[i + 1] = out.data[i + 2] = v; }
    return out;
  },
  /** Pop Art: a few strong colours, each part of the picture given one by how light it is. */
  popArt(img) {
    const out = copy(img);
    const palette = [[230, 25, 75], [255, 225, 25], [0, 130, 200], [60, 180, 75], [245, 130, 48], [145, 30, 180]];
    for (let i = 0; i < out.data.length; i += 4) {
      const band = Math.min(palette.length - 1, Math.floor(grey(out.data, i) / (256 / palette.length)));
      [out.data[i], out.data[i + 1], out.data[i + 2]] = palette[band];
    }
    return out;
  },
};

/** The filters in Format, Image, Filter, by LibreOffice's names. */
export const FILTER_MENU = [
  ['Aging', 'aging'], ['Charcoal Sketch', 'charcoal'], ['Invert', 'invert'], ['Mosaic', 'mosaic'], ['Pop Art', 'popArt'],
  ['Posterize', 'posterize'], ['Relief', 'relief'], ['Remove Noise', 'removeNoise'], ['Sharpen', 'sharpen'], ['Smooth', 'smooth'], ['Solarization', 'solarize'],
];

// Pictures in and out of pixels, in the webview.

/** Decodes picture bytes to pixels. */
export async function decodePixels(bytes, type = 'image/png') {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error('The image is too large');
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return { width: data.width, height: data.height, data: data.data };
}

/** Encodes pixels, scaled if asked, as PNG or JPEG; JPEG lays transparency on white. */
export async function encodePixels(img, { format = 'png', quality = 0.9, scale = 1 } = {}) {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const source = new OffscreenCanvas(img.width, img.height);
  source.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type, width: w, height: h };
}

/** An SVG drawn to pixels, for Convert, To Bitmap. */
export async function rasterizeSvg(svg, width, height, scale = 2) {
  const w = Math.max(1, Math.ceil(width * scale));
  const h = Math.max(1, Math.ceil(height * scale));
  if (w * h > MAX_PIXELS) throw new Error('The drawing is too large to make a picture of');
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h });
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await png.arrayBuffer());
}
