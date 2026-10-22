// Enough of the backend for the frontend to start in a plain browser.
const documents = new Map();
const staged = new Map();

// Every call is recorded, so the same fake can serve the boot test as well as
// the browser preview.
const calls = [];
window.__TAURI_CALLS__ = calls;
const listeners = {};
window.__TAURI_LISTENERS__ = listeners;

window.__TAURI__ = {
  core: {
    invoke: async (command, payload, options) => {
      calls.push({ command, payload, options });
      switch (command) {
        case 'runtime_info':
          return { ephemeral: false, version: 'preview', initialFile: null };
        case 'read_settings': return {};
        case 'write_settings': return true;

        case 'write_grt': documents.set(payload.path, payload.parts); return undefined;
        case 'read_grt':
          return { parts: documents.get(payload.path) ?? window.__TAURI_SEED__?.[payload.path] ?? {}, resources: [] };
        case 'read_resource': return new Uint8Array();
        case 'stage_part': return undefined;
        case 'clear_staged': staged.clear(); return undefined;

        case 'read_package': {
          const block = window.__TAURI_PACKAGES__?.[payload.path];
          if (!block) throw new Error(`No file at ${payload.path}`);
          return block;
        }
        case 'write_package':
          (window.__TAURI_WRITTEN__ ??= {})[decodeURIComponent(options.headers['x-grt-path'])] = payload;
          return undefined;
        case 'plugin:dialog|open': return window.__TAURI_PICK__?.open ?? null;
        case 'plugin:dialog|save': return window.__TAURI_PICK__?.save ?? null;

        case 'read_file': return new Uint8Array();
        case 'write_file_atomic': return undefined;
        case 'file_exists': return false;

        // Recovery copies, and closing with unsaved work.
        case 'recovery_begin':
          return { id: '0123456789abcdef', path: `/recovery/0123456789abcdef.${payload.extension}` };
        case 'recovery_list': return window.__TAURI_ORPHANS__ ?? [];

        // The presenter window needs a second screen and a real Tauri; in a
        // browser it does nothing rather than failing.
        case 'open_presenter': case 'close_presenter': return undefined;

        default: return null;
      }
    },
  },
  // Files dropped onto the window, and the request to close it.
  event: {
    listen: async (name, handler) => {
      listeners[name] = handler;
      return () => {};
    },
  },
};
