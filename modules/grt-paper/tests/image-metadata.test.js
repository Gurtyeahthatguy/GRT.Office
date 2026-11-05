// @vitest-environment jsdom

/** Pictures lose what the camera wrote about them: GPS, maker, author, comments, the name of the file. */

import { describe, it, expect } from 'vitest';
import { stripMetadata, neutralName } from '../src/js/core/image-metadata.js';
import { naturalSize } from '../src/js/core/images.js';

// Made with Pillow: a red 64 by 48 picture carrying GPS coordinates, a camera, an author and a comment.
const PHOTOS = {
  jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/4QC+RXhpZgAATU0AKgAAAAgABAEPAAIAAAAKAAAAPgEQAAIAAAAIAAAASAESAAMAAAABAAYA'
  + 'AIglAAQAAAABAAAAUAAAAABTZWNyZXRDYW0ATW9kZWwgWAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAhgADAAIAAAACRQAAAAAE'
  + 'AAUAAAADAAAAngAAAAAAAAAtAAAAAQAAAB4AAAABAAAAGQAAAAIAAAAJAAAAAQAAAAsAAAABAAAAAgAAAAH/4QB5aHR0cDovL25z'
  + 'LmFkb2JlLmNvbS94YXAvMS4wLwA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIj48cmRmOkRlc2NyaXB0aW9uIGNy'
  + 'ZWF0b3I9IkphY29wbyBTZWNyZXQiLz48L3g6eG1wbWV0YT7//gAQc2VjcmV0IGNvbW1lbnT/2wBDAAMCAgMCAgMDAwMEAwMEBQgF'
  + 'BQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQU'
  + 'FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEA'
  + 'AAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2Jy'
  + 'ggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm'
  + 'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAEC'
  + 'AwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcY'
  + 'GRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0'
  + 'tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwKiiivzI/uMKKKKACiiigAooo'
  + 'oAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//Z',
  png: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAFHRFWHRBdXRob3IASmFjb3BvIFNlY3JldEr0XYAAAAAgaVRYdFhN'
  + 'TDpjb20uYWRvYmUueG1wAAAAAABTZWNyZXQgWE1QZcJfbgAAALZlWElmTU0AKgAAAAgABAEPAAIAAAAKAAAAPgEQAAIAAAAIAAAA'
  + 'SAESAAMAAAABAAYAAIglAAQAAAABAAAAUAAAAABTZWNyZXRDYW0ATW9kZWwgWAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAhgAD'
  + 'AAIAAAACRQAAAAAEAAUAAAADAAAAngAAAAAAAAAtAAAAAQAAAB4AAAABAAAAGQAAAAIAAAAJAAAAAQAAAAsAAAABAAAAAgAAAAH2'
  + 'TdYaAAAAUklEQVR4nO3PMQ0AIADAMEAI/qUgCxEcDcmqYJtn7/GzpQNeNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1'
  + 'oDWgNaA1oDWgNaA1oF2vFwFk2XER3gAAAABJRU5ErkJggg==',
  webp: 'UklGRoABAABXRUJQVlA4WAoAAAAMAAAAPwAALwAAVlA4IEIAAACQAwCdASpAADAAPm02mEkkIyKhIqgAgA2JZwB2AAAqszoTaYoA'
  + 'AP7wOEP/4ta3C0sP//tLP/qWf/Us/xiVFKscAABFWElGtgAAAE1NACoAAAAIAAQBDwACAAAACgAAAD4BEAACAAAACAAAAEgBEgAD'
  + 'AAAAAQAGAACIJQAEAAAAAQAAAFAAAAAAU2VjcmV0Q2FtAE1vZGVsIFgAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAIYAAwACAAAA'
  + 'AkUAAAAABAAFAAAAAwAAAJ4AAAAAAAAALQAAAAEAAAAeAAAAAQAAABkAAAACAAAACQAAAAEAAAALAAAAAQAAAAIAAAABWE1QIFoA'
  + 'AAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIj48cmRmOkRlc2NyaXB0aW9uIGNyZWF0b3I9IkphY29wbyBTZWNy'
  + 'ZXQiLz48L3g6eG1wbWV0YT4=',
  gif: 'R0lGODlhQAAwAIEAAMgeHgAAAAAAAAAAACH+DnNlY3JldCBjb21tZW50ACwAAAAAQAAwAEAIWgABCBxIsKDBgwgTKlzIsKHDhxAj'
  + 'SpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtGnRgAA7',
};

const bytesOf = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const text = (bytes) => new TextDecoder('latin1').decode(bytes);

describe('a picture inserted into a document', () => {
  for (const [kind, base64] of Object.entries(PHOTOS)) {
    it(`loses its metadata as ${kind}, and keeps its size`, () => {
      const before = bytesOf(base64);
      expect(text(before)).toMatch(/Secret|secret/);
      const after = stripMetadata(before);
      expect(text(after)).not.toMatch(/Secret|secret|Model X|GPS/);
      if (kind !== 'webp') expect(naturalSize(after)).toEqual(naturalSize(before));
    });
  }

  it('keeps which way up a photo goes, and nothing else of its EXIF', () => {
    const after = stripMetadata(bytesOf(PHOTOS.jpg));
    const exif = text(after).indexOf('Exif\0\0');
    expect(exif).toBeGreaterThan(0);
    expect(after[exif + 25]).toBe(6);
  });

  it('drops what a camera appends after the end of the image', () => {
    const before = bytesOf(PHOTOS.jpg);
    const tail = new TextEncoder().encode('GPS 45.5 9.1 depth map');
    const joined = new Uint8Array(before.length + tail.length);
    joined.set(before);
    joined.set(tail, before.length);
    expect(text(stripMetadata(joined))).not.toMatch(/depth map/);
  });

  it('refuses a JPEG it cannot read to the end', () => {
    expect(() => stripMetadata(bytesOf(PHOTOS.jpg).subarray(0, 300))).toThrow(/damaged/);
  });

  it('takes the file names out of an SVG', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" sodipodi:docname="/home/me/plan.svg" inkscape:export-filename="/home/me/out.png"><!-- by me --><metadata><rdf:RDF>Jacopo</rdf:RDF></metadata><rect width="1" height="1"/></svg>');
    expect(new TextDecoder().decode(stripMetadata(svg))).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  });

  it('gets a name that says nothing about the file it came from', async () => {
    const name = await neutralName(bytesOf(PHOTOS.png), '/home/jacopo/Pictures/IMG_casa_mia.PNG');
    expect(name).toMatch(/^resources\/picture-[0-9a-f]{12}\.png$/);
    expect(await neutralName(bytesOf(PHOTOS.png), 'other.png')).toBe(name);
  });
});
