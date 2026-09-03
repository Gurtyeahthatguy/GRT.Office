// Enough of the Tauri surface for the frontend to start in a plain browser.
const store = new Map();
window.__TAURI__ = {
  core: {
    invoke: async (command, payload) => {
      switch (command) {
        case 'runtime_info':
          return { ephemeral: false, version: 'preview', initialFile: null };
        case 'read_settings': return {};
        case 'write_settings': return true;
        case 'write_grt': store.set(payload.path, payload.parts); return undefined;
        case 'read_grt': return { parts: store.get(payload.path) ?? {}, resources: [] };
        case 'read_file': return new Uint8Array();
        case 'write_file_atomic': return undefined;
        case 'file_exists': return false;
        default: return null;
      }
    },
  },
};
