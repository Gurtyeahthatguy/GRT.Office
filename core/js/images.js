/** The size a picture says it is, read from its own header. */

/** @returns {?{w: number, h: number}} in pixels, or null if the format is not known */
export function naturalSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: view.getUint16(6, true), h: view.getUint16(8, true) };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return { w: Math.abs(view.getInt32(18, true)), h: Math.abs(view.getInt32(22, true)) };
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xFF) return null;
      const marker = bytes[at + 1];
      const length = view.getUint16(at + 2);
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { w: view.getUint16(at + 7), h: view.getUint16(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

/** A picture's size on the page: its own, made to fit a width. */
export function fittedSize(bytes, maxWidth = 600) {
  const size = naturalSize(bytes);
  if (!size || size.w === 0 || size.h === 0) return { w: 400, h: 260 };
  const scale = Math.min(1, maxWidth / size.w);
  return { w: Math.round(size.w * scale), h: Math.round(size.h * scale) };
}
