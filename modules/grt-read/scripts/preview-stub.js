// Enough of the backend for the frontend to start in a plain browser.

/**
 * A minimal but valid two-page PDF, with the cross-reference table computed.
 */
function buildSamplePdf() {
  const pageText = (text) =>
    `BT /F1 24 Tf 60 760 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;

  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    null,   // filled below: the first page's content stream.
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    null,   // the second page's content stream.
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (A sample document) /Author (Someone Else) '
      + '/Creator (Another Program) /Producer (Another Program) >>',
  ];

  const stream = (text) => {
    const content = pageText(text);
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  };

  bodies[3] = stream('Page one of the preview');
  bodies[5] = stream('Page two, so paging has something to do');

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  bodies.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  const pad = (n, width) => String(n).padStart(width, '0');

  pdf += `xref\n0 ${bodies.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${pad(offset, 10)} 00000 n \n`;

  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 8 0 R >>\n`;
  pdf += `startxref\n${xrefAt}\n%%EOF\n`;

  // latin1 so that every byte written above survives as itself.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

const sample = buildSamplePdf();

// Every call is recorded, so the same fake can serve the boot test as well as
// the browser preview.
window.__TAURI_CALLS__ = [];

window.__TAURI__ = {
  core: {
    invoke: async (command, payload, options) => {
      window.__TAURI_CALLS__.push({ command, payload, options });
      switch (command) {
        case 'runtime_info':
          return {
            ephemeral: false,
            version: 'preview',
            // Opening straight into the sample: an empty window shows
            // nothing.
            initialFile: '/preview/sample.pdf',
          };
        case 'read_settings': return {};
        case 'write_settings': return true;
        case 'forget_settings': return undefined;

        case 'read_file': return sample;
        case 'write_file_atomic': return undefined;
        case 'file_exists': return payload?.path === '/preview/sample.pdf';

        default: return null;
      }
    },
  },

  // Dropping a file onto the window.
  event: { listen: async () => () => {} },
};
