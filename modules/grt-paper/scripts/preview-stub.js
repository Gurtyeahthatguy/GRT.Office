// Enough of the backend for the frontend to start in a plain browser.
const documents = new Map();

// Every call is recorded, so the same fake can serve the boot test as well as
// the browser preview.
window.__TAURI_CALLS__ = [];

window.__TAURI__ = {
  core: {
    invoke: async (command, payload, options) => {
      window.__TAURI_CALLS__.push({ command, payload, options });
      switch (command) {
        case 'runtime_info':
          return { ephemeral: false, version: 'preview', initialFile: null };
        case 'read_settings': return {};
        case 'write_settings': return true;
        case 'forget_settings': return undefined;

        case 'write_grt': documents.set(payload.path, payload.parts); return undefined;
        case 'read_grt': return { parts: documents.get(payload.path) ?? {}, resources: [] };
        case 'read_resource': return new Uint8Array();
        case 'stage_part': case 'clear_staged': return undefined;
        case 'read_zip': return { parts: {}, binaries: [] };

        case 'read_file': return new Uint8Array();
        case 'write_file_atomic': return undefined;
        case 'file_exists': return false;

        default: return null;
      }
    },
  },
  // Paper listens for files dropped onto the window.
  event: { listen: async () => () => {} },
};
