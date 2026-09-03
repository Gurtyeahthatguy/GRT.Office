// Enough of the backend for the frontend to start in a plain browser.
const files = new Map();

files.set('/preview/Personal.ics', [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//GRT//Calendar//EN',
  'X-WR-CALNAME:Personal',
  'BEGIN:VEVENT',
  'UID:preview-1',
  'DTSTAMP:19800101T000000Z',
  'SUMMARY:Dentist',
  `DTSTART:${offsetDay(1)}T100000`,
  `DTEND:${offsetDay(1)}T110000`,
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:preview-2',
  'DTSTAMP:19800101T000000Z',
  'SUMMARY:Weekly review',
  `DTSTART:${offsetDay(2)}T150000`,
  `DTEND:${offsetDay(2)}T160000`,
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'BEGIN:VTODO',
  'UID:preview-3',
  'DTSTAMP:19800101T000000Z',
  'SUMMARY:Post the form',
  `DUE;VALUE=DATE:${offsetDay(4)}`,
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n'));

files.set('/preview/Work.ics', [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//GRT//Calendar//EN',
  'X-WR-CALNAME:Work',
  'BEGIN:VEVENT',
  'UID:preview-4',
  'DTSTAMP:19800101T000000Z',
  'SUMMARY:All-day conference',
  `DTSTART;VALUE=DATE:${offsetDay(3)}`,
  `DTEND;VALUE=DATE:${offsetDay(4)}`,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n'));

/** A date this many days from today, as an iCalendar DATE value. */
function offsetDay(days) {
  const at = new Date();
  at.setDate(at.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
}

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
            initialFile: null,
            defaultDirectory: '/preview',
          };
        case 'read_settings': return {};
        case 'write_settings': return true;
        case 'forget_settings': return undefined;

        case 'list_calendars':
          return {
            directory: '/preview',
            calendars: [...files.keys()].map((path) => ({
              name: path.split('/').pop().replace(/\.ics$/, ''),
              path,
            })),
          };

        case 'read_file':
          return new TextEncoder().encode(files.get(payload.path) ?? '');

        case 'write_file_atomic': return undefined;
        case 'remove_calendar': files.delete(payload.path); return undefined;
        case 'file_exists': return files.has(payload.path);

        default: return null;
      }
    },
  },
};
