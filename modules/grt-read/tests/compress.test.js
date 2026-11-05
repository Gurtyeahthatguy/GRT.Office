/** A smaller copy: JPEG pictures encoded again only where that saves bytes, and only the kinds whose colours survive it. */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { recompressImages, LEVELS } from '../src/js/compress.js';

// A 16 by 12 colour JPEG.
const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAMABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5r8J/BT7n+j/pXs3hP4Kfc/cfpXtvhTwpp3yfua9m8KeFNO+T9zUZzxfiNdzzPDbjzF+5v0P/2Q=='), (c) => c.charCodeAt(0));

async function withPictures() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 200]);
  const picture = await doc.embedJpg(JPEG);
  page.drawImage(picture, { x: 10, y: 10, width: 100, height: 75 });
  // A second picture with a colour key mask, which a lossy encoding would break.
  const masked = await doc.embedJpg(JPEG);
  page.drawImage(masked, { x: 10, y: 100, width: 50, height: 40 });
  await doc.flush();
  const raw = doc.context.lookup(masked.ref);
  raw.dict.set(PDFName.of('Mask'), doc.context.obj([0, 10, 0, 10, 0, 10]));
  return doc;
}

const images = (doc) => [...doc.context.enumerateIndirectObjects()]
  .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.asString() === '/Image')
  .map(([ref, o]) => ({ ref, width: o.dict.get(PDFName.of('Width')).asNumber(), length: o.contents.length, masked: Boolean(o.dict.get(PDFName.of('Mask'))) }));

describe('a smaller copy', () => {
  it('replaces a picture by a smaller one of the size it was made, and leaves a masked one alone', async () => {
    const doc = await withPictures();
    const asked = [];
    const smaller = new Uint8Array(100);
    const stats = await recompressImages(doc, LEVELS.medium, async (jpeg, level) => {
      asked.push(level.quality);
      return { bytes: smaller, width: 8, height: 6 };
    });
    expect(stats.pictures).toBe(1);
    expect(asked).toEqual([0.7]);
    const after = images(doc);
    expect(after.find((i) => !i.masked)).toMatchObject({ width: 8, length: 100 });
    expect(after.find((i) => i.masked)).toMatchObject({ width: 16, length: JPEG.length });
    // The file still saves and opens.
    const again = await PDFDocument.load(await doc.save());
    expect(again.getPageCount()).toBe(1);
  });

  it('keeps a picture that would come out larger, or that the encoder cannot read', async () => {
    const doc = await withPictures();
    expect((await recompressImages(doc, LEVELS.light, async () => ({ bytes: new Uint8Array(JPEG.length + 1), width: 16, height: 12 }))).pictures).toBe(0);
    expect((await recompressImages(doc, LEVELS.light, async () => { throw new Error('cannot decode'); })).pictures).toBe(0);
    expect(images(doc).every((i) => i.length === JPEG.length)).toBe(true);
  });
});
