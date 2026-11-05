/** Templates: the same files as documents, marked so that opening one starts a new document from it. */

/** Each template extension and the document format it is written as. */
export const TEMPLATE_OF = { ott: 'odt', ots: 'ods', otp: 'odp', otg: 'odg', dotx: 'docx', xltx: 'xlsx', potx: 'pptx' };

const OOXML_MAIN = {
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'],
};

/** Office's templates with macros: opened as templates, their macros declared and never run, and never written. */
export const MACRO_TEMPLATE_OF = { dotm: 'docx', xltm: 'xlsx', potm: 'pptx' };

export const isTemplate = (format) => Object.hasOwn(TEMPLATE_OF, String(format ?? '').toLowerCase()) || Object.hasOwn(MACRO_TEMPLATE_OF, String(format ?? '').toLowerCase());

/** The format a file is read and written as: the document format for a template, the format itself otherwise. */
export const baseFormat = (format) => TEMPLATE_OF[String(format ?? '').toLowerCase()] ?? MACRO_TEMPLATE_OF[String(format ?? '').toLowerCase()] ?? format;

const text = (data) => (typeof data === 'string' ? data : new TextDecoder().decode(data));

/**
 * A written document turned into a template of its kind.
 * @param {{name: string, data: string|Uint8Array}[]} entries the package's entries as a writer returned them
 * @param {string} format the template extension, such as `ots`
 */
export function asTemplate(entries, format) {
  const base = TEMPLATE_OF[format];
  if (!base) return entries;
  if (base.startsWith('o')) {
    let mimetype = null;
    return entries.map((entry) => {
      if (entry.name === 'mimetype') {
        mimetype = text(entry.data).trim();
        return { ...entry, data: `${mimetype}-template` };
      }
      if (entry.name === 'META-INF/manifest.xml' && mimetype) {
        return { ...entry, data: text(entry.data).replace(`manifest:media-type="${mimetype}"`, `manifest:media-type="${mimetype}-template"`) };
      }
      return entry;
    });
  }
  const [document, template] = OOXML_MAIN[base];
  return entries.map((entry) => (entry.name === '[Content_Types].xml' ? { ...entry, data: text(entry.data).replace(document, template) } : entry));
}

/** A flat OpenDocument file's text turned into a template. */
export function flatAsTemplate(xml) {
  return xml.replace(/office:mimetype="([^"]+?)(-template)?"/, 'office:mimetype="$1-template"');
}
