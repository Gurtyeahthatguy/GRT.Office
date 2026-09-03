/** Application wiring. */

import { DocumentModel } from './document-model.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { UndoStack } from './core/undo.js';
import { buildBytesFromPlan, writeBytes } from './save.js';
import { inspectBytes, renderReport } from './fingerprint.js';
import {
  loadSettings, updateSettings, settings, canPersist, forgetSettings,
} from './settings.js';
import { openPalette, isPaletteOpen } from './core/palette.js';
import {
  showPanel, readFields, isDialogOpen,
  stampForm, cropForm, metadataForm, splitForm, settingsForm,
} from './dialogs.js';
import {
  pickPdfToOpen, pickPdfToSave, pickDirectory, readFileBytes, fileExists,
  runtimeInfo, onFilesDropped, baseName, withSuffix, joinPath,
} from './io.js';

const el = (id) => document.getElementById(id);

const ui = {
  pages: el('pages'),
  thumbs: el('thumbnails'),
  workspace: document.querySelector('.workspace'),
  empty: el('empty-state'),
  toast: el('toast'),
  zoomLabel: el('zoom-label'),
  pageIndicator: el('page-indicator'),
  searchInput: el('search-input'),
  searchStatus: el('search-status'),
};

const viewer = new Viewer(ui.pages);
const thumbs = new Thumbnails(ui.thumbs, viewer);

let model = null;
let undo = null;
let busy = false;
let searchHits = [];
let searchCursor = -1;

/** Decorations and metadata that get applied when bytes are produced. */
let exportOptions = { watermark: null, pageNumbers: null, metadata: null };

// Notifications

let toastTimer = null;
function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.add('hidden'), 3600);
}

/** Wraps anything that can fail against a real file. */
async function guard(label, action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (err) {
    console.error(`[GRT] ${label} failed`, err);
    toast(`${label} failed: ${err.message ?? err}`, true);
  } finally {
    busy = false;
    refreshControls();
  }
}

// Opening

async function openPath(path) {
  const bytes = await readFileBytes(path);

  await viewer.reset();
  // The page count comes from PDF.js, so the model is built already knowing
  // its size rather than being resized afterwards.
  const pageCount = await viewer.addSource(0, bytes);
  model = new DocumentModel(bytes, pageCount, path);

  undo = new UndoStack(model);
  exportOptions = { watermark: null, pageNumbers: null, metadata: null };
  if (viewer.markMode !== 'select') setMarkMode(viewer.markMode);
  thumbs.clearSelection();
  clearSearch();

  await rebuild();
  await applyOpenZoom();

  ui.empty.classList.add('hidden');
  document.title = `${baseName(path)} — GRT Read`;
  toast(`Opened ${baseName(path)} — ${pageCount} page${pageCount === 1 ? '' : 's'}`);
}

async function appendPath(path) {
  const bytes = await readFileBytes(path);
  const sourceId = model.sources.length;
  const pageCount = await viewer.addSource(sourceId, bytes);

  undo.do(() => model.appendSource(bytes, pageCount));
  await rebuild();
  toast(`Appended ${pageCount} page${pageCount === 1 ? '' : 's'} from ${baseName(path)}`);
}

// View refresh

async function rebuild() {
  await viewer.layout(model);
  if (settings().showThumbnails) await thumbs.layout(model);
  refreshControls();
  updatePageIndicator();
}

function refreshControls() {
  const hasDoc = model !== null;
  for (const node of document.querySelectorAll('.needs-doc')) {
    node.disabled = !hasDoc || busy;
  }
  el('btn-undo').disabled = !hasDoc || busy || !undo?.canUndo;
  el('btn-redo').disabled = !hasDoc || busy || !undo?.canRedo;
  el('btn-extract').disabled = !hasDoc || busy || thumbs.selected.length === 0;
  ui.zoomLabel.textContent = `${Math.round(viewer.scale * 100)}%`;
}

function updatePageIndicator() {
  if (!model) {
    ui.pageIndicator.textContent = '';
    return;
  }
  const notes = [];
  if (model.dirty) notes.push('unsaved changes');
  if (exportOptions.watermark?.text) notes.push('watermark');
  if (exportOptions.pageNumbers) notes.push('numbers');
  const redactions = model.countMarks('redact');
  if (redactions > 0) notes.push(`${redactions} redaction${redactions === 1 ? '' : 's'}`);
  const highlights = model.countMarks('highlight');
  if (highlights > 0) notes.push(`${highlights} highlight${highlights === 1 ? '' : 's'}`);
  const suffix = notes.length ? ` • ${notes.join(' • ')}` : '';
  ui.pageIndicator.textContent =
    `Page ${viewer.currentPage + 1} of ${model.visibleCount}${suffix}`;
}

viewer.onPageChange = (viewIndex) => {
  thumbs.setCurrent(viewIndex);
  updatePageIndicator();
};

thumbs.onActivate = (viewIndex) => viewer.scrollToPage(viewIndex);
thumbs.onSelect = () => refreshControls();
thumbs.onReorder = (from, to) => guard('Reorder', async () => {
  undo.do(() => model.movePage(from, to));
  thumbs.clearSelection();
  await rebuild();
});

// Page operations

/** Pages an action applies to: the selection, or the page on screen. */
function targetPages() {
  const selected = thumbs.selected;
  return selected.length > 0 ? selected : [viewer.currentPage];
}

function rotate(degrees) {
  return guard('Rotate', async () => {
    const targets = targetPages();
    undo.do(() => {
      for (const viewIndex of targets) model.rotatePage(viewIndex, degrees);
    });
    await rebuild();
  });
}

function deletePages() {
  return guard('Delete', async () => {
    const targets = targetPages();
    undo.do(() => model.deletePages(targets));
    thumbs.clearSelection();
    await rebuild();
    toast(`Deleted ${targets.length} page${targets.length === 1 ? '' : 's'}`);
  });
}

function step(direction) {
  return guard(direction > 0 ? 'Redo' : 'Undo', async () => {
    const moved = direction > 0 ? undo.redo() : undo.undo();
    if (!moved) return;
    thumbs.clearSelection();
    await rebuild();
  });
}

// Marking

/**
 * Highlight and redact share one interaction: pick a mode, drag a rectangle.
 */
function setMarkMode(mode) {
  viewer.markMode = viewer.markMode === mode ? 'select' : mode;
  ui.pages.classList.toggle('marking', viewer.markMode !== 'select');
  el('btn-highlight').setAttribute('aria-pressed', String(viewer.markMode === 'highlight'));
  el('btn-redact').setAttribute('aria-pressed', String(viewer.markMode === 'redact'));

  if (viewer.markMode === 'redact') {
    toast('Redact: what you cover is deleted from the file, not hidden');
  } else if (viewer.markMode === 'highlight') {
    toast('Highlight: drag over the page. Nothing is removed');
  }
}

viewer.onMarkDrawn = (viewIndex, type, rect) => guard('Mark', async () => {
  undo.do(() => model.addMark(viewIndex, type, rect));
  await rebuild();
  updatePageIndicator();
});

function clearMarks() {
  return guard('Clear marks', async () => {
    const targets = targetPages();
    undo.do(() => model.clearMarks(targets));
    await rebuild();
    toast('Marks removed');
  });
}

function cropPages() {
  return guard('Crop', async () => {
    const targets = targetPages();
    const confirmed = await showPanel('Crop pages', cropForm(targets.length), 'Apply');
    if (!confirmed) return;

    const f = readFields();
    const crop = {
      top: (f.top ?? 0) / 100,
      bottom: (f.bottom ?? 0) / 100,
      left: (f.left ?? 0) / 100,
      right: (f.right ?? 0) / 100,
    };

    if (Object.values(crop).every((v) => v === 0)) {
      undo.do(() => model.clearCrop(targets));
      await rebuild();
      toast('Cropping removed');
      return;
    }

    undo.do(() => model.cropPages(targets, crop));
    await rebuild();
    toast(`Cropped ${targets.length} page${targets.length === 1 ? '' : 's'}`);
  });
}

// Zoom

async function setZoom(scale) {
  await viewer.setScale(scale, model);
  if (settings().showThumbnails) await thumbs.layout(model);
  refreshControls();
}

async function applyOpenZoom() {
  if (!model) return;
  await setZoom(settings().openZoom === 'actual' ? 1 : viewer.fitWidth(model));
}

// Search

function clearSearch() {
  searchHits = [];
  searchCursor = -1;
  ui.searchStatus.textContent = '';
  delete ui.searchInput.dataset.lastQuery;
}

function runSearch() {
  return guard('Search', async () => {
    const query = ui.searchInput.value;
    if (!query.trim()) {
      clearSearch();
      return;
    }

    // Repeating the same query steps through the results instead of searching
    // again, which on a long document is the difference between instant and
    // several seconds.
    if (searchHits.length > 0 && ui.searchInput.dataset.lastQuery === query) {
      searchCursor = (searchCursor + 1) % searchHits.length;
    } else {
      ui.searchStatus.textContent = 'Searching…';
      searchHits = await viewer.findText(query, model);
      searchCursor = 0;
      ui.searchInput.dataset.lastQuery = query;
    }

    if (searchHits.length === 0) {
      ui.searchStatus.textContent = 'No matches';
      return;
    }

    ui.searchStatus.textContent =
      `${searchCursor + 1} of ${searchHits.length} page${searchHits.length === 1 ? '' : 's'}`;
    viewer.scrollToPage(searchHits[searchCursor]);
  });
}

// Producing bytes

function buildOptions(audit = true) {
  return { audit, ...exportOptions };
}

/** Counts the panel needs, which the bytes alone cannot reveal. */
function reportContext() {
  return {
    redactions: model.countMarks('redact'),
    highlights: model.countMarks('highlight'),
    cropped: model.visiblePages.filter((p) => p.crop).length,
  };
}

/** The path every write goes through. */
async function writeWithConfirmation(bytes, path, title) {
  if (settings().fingerprintBeforeSave) {
    const report = await inspectBytes(bytes);
    const approved = await showPanel(title, renderReport(report, reportContext()), 'Save');
    if (!approved) return false;
  }
  await writeBytes(bytes, path);
  return true;
}

function save(forceDialog) {
  return guard('Save', async () => {
    let path = forceDialog ? null : model.path;
    if (!path) {
      path = await pickPdfToSave(model.path ?? 'document.pdf', 'Save PDF');
      if (!path) return;
    }

    const bytes = await buildBytesFromPlan(model, model.buildPlan(), buildOptions());
    const written = await writeWithConfirmation(
      bytes, path, `Fingerprint — ${baseName(path)}`,
    );
    if (!written) return;

    model.path = path;
    model.dirty = false;
    document.title = `${baseName(path)} — GRT Read`;
    updatePageIndicator();
    toast(`Saved ${baseName(path)}`);
  });
}

function extract() {
  return guard('Extract', async () => {
    const targets = thumbs.selected;
    if (targets.length === 0) return;

    const path = await pickPdfToSave(withSuffix(model.path, '-extract'), 'Extract pages to');
    if (!path) return;

    const bytes = await buildBytesFromPlan(
      model, model.buildPlanFor(targets), buildOptions(),
    );
    const written = await writeWithConfirmation(
      bytes, path, `Fingerprint — ${targets.length} extracted page(s)`,
    );
    if (written) toast(`Extracted ${targets.length} page(s)`);
  });
}

function split() {
  return guard('Split', async () => {
    const confirmed = await showPanel('Split document', splitForm(model.visibleCount), 'Choose folder');
    if (!confirmed) return;

    const fields = readFields();
    const size = Math.max(1, Math.floor(fields.size || 1));
    const prefix = (fields.prefix || 'part').replace(/[\\/:*?"<>|]/g, '_');

    const directory = await pickDirectory('Where to write the pieces');
    if (!directory) return;

    const total = model.visibleCount;
    const chunks = Math.ceil(total / size);
    // Zero-padded so the pieces sort correctly in a file manager.
    const width = String(chunks).length;

    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const indices = [];
      for (let i = chunk * size; i < Math.min((chunk + 1) * size, total); i += 1) {
        indices.push(i);
      }
      const bytes = await buildBytesFromPlan(
        model, model.buildPlanFor(indices), buildOptions(false),
      );
      const name = `${prefix}-${String(chunk + 1).padStart(width, '0')}.pdf`;
      await writeBytes(bytes, joinPath(directory, name));
    }

    toast(`Wrote ${chunks} file${chunks === 1 ? '' : 's'} into ${baseName(directory)}`);
  });
}

function showFingerprint() {
  return guard('Fingerprint', async () => {
    const bytes = await buildBytesFromPlan(model, model.buildPlan(), buildOptions());
    await showPanel(
      'Fingerprint of the unsaved output',
      renderReport(await inspectBytes(bytes), reportContext()),
    );
  });
}

// Output options

function editStamp() {
  return guard('Stamp', async () => {
    const confirmed = await showPanel('Watermark and page numbers',
      stampForm({
        watermark: exportOptions.watermark ?? {},
        pageNumbers: exportOptions.pageNumbers
          ? { ...exportOptions.pageNumbers, enabled: true }
          : {},
      }), 'Apply');
    if (!confirmed) return;

    const f = readFields();
    exportOptions.watermark = f.watermarkText?.trim()
      ? { text: f.watermarkText.trim(), opacity: f.watermarkOpacity }
      : null;
    exportOptions.pageNumbers = f.numbersOn
      ? {
        start: f.numbersStart,
        format: f.numbersFormat || '{n}',
        position: f.numbersPosition,
      }
      : null;

    updatePageIndicator();
    toast('Applied to the next save; the pages on screen are unchanged');
  });
}

function editMetadata() {
  return guard('Metadata', async () => {
    const confirmed = await showPanel('Metadata to write',
      metadataForm(exportOptions.metadata ?? {}), 'Apply');
    if (!confirmed) return;

    const f = readFields();
    const any = ['title', 'author', 'subject', 'keywords', 'creator', 'producer']
      .some((key) => f[key]?.trim());
    exportOptions.metadata = any ? f : null;
    toast(any ? 'Metadata will be written on save' : 'Metadata will stay cleared');
  });
}

// Settings

function applySettingsToUi() {
  ui.workspace.classList.toggle('no-thumbs', !settings().showThumbnails);
}

function openSettings() {
  return guard('Settings', async () => {
    const before = { ...settings() };
    const confirmed = await showPanel('Settings',
      settingsForm(before, canPersist()), 'Apply');
    if (!confirmed) return;

    const f = readFields();
    const stored = await updateSettings({
      theme: f.theme,
      showThumbnails: f.showThumbnails,
      openZoom: f.openZoom,
      fingerprintBeforeSave: f.fingerprintBeforeSave,
    });

    applySettingsToUi();
    if (model && before.showThumbnails !== settings().showThumbnails) {
      await rebuild();
    }

    toast(stored ? 'Settings saved' : 'Settings applied for this session only');
  });
}

// Command palette

/** Every command, in one list. */
function commands() {
  const entry = (label, hint, run) => ({ id: label, label, hint, run });
  const needsDoc = (label, hint, run) => entry(label, hint, () => {
    if (!model) {
      toast('Open a PDF first');
      return;
    }
    run();
  });

  return [
    entry('Open…', 'Ctrl+O', () => el('btn-open').click()),
    entry('Settings…', 'Ctrl+,', () => openSettings()),

    needsDoc('Save', 'Ctrl+S', () => save(false)),
    needsDoc('Save as…', 'Ctrl+Shift+S', () => save(true)),
    needsDoc('Append another PDF…', '', () => el('btn-merge').click()),
    needsDoc('Split into several files…', '', () => split()),
    needsDoc('Extract selected pages…', '', () => extract()),
    needsDoc('Fingerprint', '', () => showFingerprint()),

    needsDoc('Rotate left', '', () => rotate(-90)),
    needsDoc('Rotate right', '', () => rotate(90)),
    needsDoc('Rotate 180', '', () => rotate(180)),
    needsDoc('Delete pages', 'Del', () => deletePages()),
    needsDoc('Crop pages…', '', () => cropPages()),

    needsDoc('Highlight mode', 'H', () => setMarkMode('highlight')),
    needsDoc('Redact mode', 'R', () => setMarkMode('redact')),
    needsDoc('Clear marks on the selection', '', () => clearMarks()),

    needsDoc('Watermark and page numbers…', '', () => editStamp()),
    needsDoc('Metadata to write…', '', () => editMetadata()),

    needsDoc('Fit page width', '', () => zoomToFit()),
    needsDoc('Actual size', '', () => setZoom(1)),
    needsDoc('Undo', 'Ctrl+Z', () => step(-1)),
    needsDoc('Redo', 'Ctrl+Y', () => step(1)),
  ];
}

// Events

el('btn-open').onclick = () => guard('Open', async () => {
  const path = await pickPdfToOpen();
  if (path) await openPath(path);
});

el('btn-merge').onclick = () => guard('Append', async () => {
  const path = await pickPdfToOpen('Append PDF');
  if (path) await appendPath(path);
});

el('btn-save').onclick = () => save(false);
el('btn-save-as').onclick = () => save(true);
el('btn-extract').onclick = () => extract();
el('btn-split').onclick = () => split();
el('btn-stamp').onclick = () => editStamp();
el('btn-crop').onclick = () => cropPages();
el('btn-highlight').onclick = () => setMarkMode('highlight');
el('btn-redact').onclick = () => setMarkMode('redact');
el('btn-clear-marks').onclick = () => clearMarks();
el('btn-metadata').onclick = () => editMetadata();
el('btn-fingerprint').onclick = () => showFingerprint();
el('btn-settings').onclick = () => openSettings();
el('btn-commands').onclick = () => openPalette(commands());
el('btn-undo').onclick = () => step(-1);
el('btn-redo').onclick = () => step(1);
el('btn-rotate-left').onclick = () => rotate(-90);
el('btn-rotate-right').onclick = () => rotate(90);
el('btn-delete').onclick = () => deletePages();
el('btn-zoom-in').onclick = () => guard('Zoom', () => setZoom(viewer.scale * 1.25));
el('btn-zoom-out').onclick = () => guard('Zoom', () => setZoom(viewer.scale / 1.25));
el('btn-zoom-fit').onclick = () => guard('Zoom', () => setZoom(viewer.fitWidth(model)));
el('btn-search').onclick = () => runSearch();

ui.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runSearch();
});

document.addEventListener('keydown', (event) => {
  // While a dialog or the palette is open it owns the keyboard; each has its
  // own handler for Escape and Enter.
  if (isDialogOpen() || isPaletteOpen()) return;

  const typing = event.target instanceof HTMLInputElement;
  const ctrl = event.ctrlKey || event.metaKey;

  if (ctrl && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette(commands());
  } else if (ctrl && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    el('btn-open').click();
  } else if (ctrl && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (model) save(event.shiftKey);
  } else if (ctrl && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    ui.searchInput.focus();
    ui.searchInput.select();
  } else if (ctrl && event.key === ',') {
    event.preventDefault();
    openSettings();
  } else if (ctrl && event.key.toLowerCase() === 'z' && !typing) {
    event.preventDefault();
    step(event.shiftKey ? 1 : -1);
  } else if (ctrl && event.key.toLowerCase() === 'y' && !typing) {
    event.preventDefault();
    step(1);
  } else if (event.key === 'Delete' && !typing && model) {
    event.preventDefault();
    deletePages();
  } else if (event.key.toLowerCase() === 'h' && !typing && !ctrl && model) {
    setMarkMode('highlight');
  } else if (event.key.toLowerCase() === 'r' && !typing && !ctrl && model) {
    setMarkMode('redact');
  } else if (event.key === 'Escape') {
    // Escape leaves marking first, and only clears the selection once there
    // is no mode to leave.
    if (viewer.markMode !== 'select') setMarkMode(viewer.markMode);
    else thumbs.clearSelection();
  }
});

// Dropping a file opens it; dropping onto an open document appends it, which
// is the gesture people expect from a viewer that can merge.
onFilesDropped((paths) => guard('Open', async () => {
  if (!model) {
    await openPath(paths[0]);
    for (const path of paths.slice(1)) await appendPath(path);
  } else {
    for (const path of paths) await appendPath(path);
  }
}));

window.addEventListener('resize', () => {
  if (model) thumbs.setCurrent(viewer.currentPage);
});

// Startup

(async function start() {
  const info = await runtimeInfo();
  await loadSettings(info.ephemeral);
  applySettingsToUi();

  if (info.ephemeral) el('ephemeral-note').classList.remove('hidden');
  refreshControls();

  // A file named on the command line opens straight away.
  const initial = info.initialFile
    ?? new URLSearchParams(window.location.search).get('open');
  if (initial && await fileExists(initial)) {
    await guard('Open', () => openPath(initial));
  }
}());

// Exposed for the settings panel's "forget everything" affordance and for
// anyone poking at the program from the webview console.
window.GRT = { forgetSettings };
