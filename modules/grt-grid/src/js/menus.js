/** Grid's menus; each item names what LibreOffice and Excel call it, so the palette finds it by those names. */

import * as dialogs from './dialogs.js';
import * as sheets from './sheets.js';

/**
 * @param {{sheet: () => import('./controller.js').SheetController, actions: Object, toast: Function}} app
 */
export function gridMenus({ sheet, actions, toast }) {
  const s = () => sheet();
  // The look of the cell the cursor is on, which the buttons and ticks show, as in Calc.
  const here = () => s().styleAt(s().active.row, s().active.col);
  const many = () => !s().selectionIsSingle;
  const filtered = () => Boolean(s().sheet.filter);
  const frozen = () => Boolean(s().sheet.frozen?.rows || s().sheet.frozen?.cols);
  const rows = () => s().selection.bottom - s().selection.top + 1;
  const cols = () => s().selection.right - s().selection.left + 1;

  const t = actions.text;
  const marks = t.marks.map((m) => ({ label: m.label.replace(/^\w/, (c) => c.toUpperCase()), shortcut: m.shortcut, run: () => t.insertChars(m.char) }));

  return [
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', run: actions.newFile, aliases: ['New spreadsheet'] },
        { label: 'Open…', shortcut: 'Ctrl+O', run: actions.open },
        { label: 'Import CSV…', run: actions.importCsv, aliases: ['Text CSV', 'Open CSV'] },
        { label: 'Templates', items: [
          { label: 'Manage Templates…', shortcut: 'Ctrl+Shift+N', run: actions.templates, aliases: ['Templates…', 'Templates', 'New from template'] },
          { label: 'Save as Template…', run: actions.saveTemplate, aliases: ['Save as template…', 'Edit Template'] },
        ] },
        { label: 'Reload', run: actions.reload, aliases: ['Revert'] },
        'separator',
        { label: 'Save', shortcut: 'Ctrl+S', run: actions.save },
        { label: 'Save As…', shortcut: 'Ctrl+Shift+S', run: actions.saveAs, aliases: ['Save as…'] },
        { label: 'Save a Copy…', run: actions.saveCopy, aliases: ['Save a copy…'] },
        'separator',
        { label: 'Export as', items: [
          { label: 'Export as PDF…', run: actions.exportPdf, aliases: ['Export PDF…', 'Export directly as PDF'] },
          { label: 'Export as CSV…', run: actions.exportCsv, aliases: ['Export CSV…'] },
          { label: 'Redacted Export…', run: actions.redactedExport, aliases: ['Redacted Export (Black)', 'Export redacted', 'Share a redacted copy'] },
        ] },
        'separator',
        { label: 'Print…', shortcut: 'Ctrl+P', run: actions.print, aliases: ['Print preview'] },
        'separator',
        { label: 'Properties…', run: actions.properties, aliases: ['Document properties', 'Statistics'] },
        { label: 'Inspect Document…', run: actions.inspect, aliases: ['Document inspector', 'Remove personal information', 'Clean copy', 'Prepare for sharing'] },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: () => s().step(-1), enabled: () => s().undo.canUndo },
        { label: 'Redo', shortcut: 'Ctrl+Y', run: () => s().step(1), enabled: () => s().undo.canRedo },
        'separator',
        { label: 'Paste Special', items: [
          { label: 'Paste Unformatted Text', shortcut: 'Ctrl+Alt+Shift+V', run: actions.pasteUnformatted, aliases: ['Paste unformatted text', 'Paste as plain text'] },
          { label: 'Paste Only Text', run: () => actions.pasteSome({ numbers: false, formulas: false, formats: false }), aliases: ['Paste only text'] },
          { label: 'Paste Only Numbers', run: () => actions.pasteSome({ text: false, formulas: false, formats: false }), aliases: ['Paste only numbers'] },
          { label: 'Paste Only Formula', run: () => actions.pasteSome({ text: false, numbers: false, formats: false }), aliases: ['Paste only formulas'] },
          { label: 'Paste Transposed', run: () => actions.pasteSome({ transpose: true }), aliases: ['Paste transposed', 'Transpose'] },
          'separator',
          { label: 'Paste Special…', shortcut: 'Ctrl+Shift+V', run: actions.pasteSpecial, aliases: ['Paste special…'] },
        ] },
        { label: 'Select', items: [
          { label: 'Select Row', run: () => s().selectWhole('row'), aliases: ['Select row'] },
          { label: 'Select Column', run: () => s().selectWhole('col'), aliases: ['Select column'] },
          { label: 'Select Data Area', shortcut: 'Ctrl+*', run: () => s().selectDataArea(), aliases: ['Select data area', 'Current region'] },
        ] },
        'separator',
        { label: 'Search Everywhere…', run: actions.everywhere, aliases: ['Search everywhere', 'Search in files', 'Find in folder', 'Search all documents'] },
        { label: 'Find and Replace…', shortcut: 'Ctrl+H', run: () => dialogs.findReplaceDialog(s(), toast), aliases: ['Find and replace…', 'Find & Replace', 'Search', 'Replace', 'Find Toolbar', 'vnd.sun.star.findbar:FocusToFindbar'] },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Value Highlighting', shortcut: 'Ctrl+F8', run: () => s().toggleView('values'), checked: () => s().view.values, aliases: ['Value highlighting'] },
        { label: 'Show Formula', shortcut: 'Ctrl+`', run: () => s().toggleView('formulas'), checked: () => s().view.formulas, aliases: ['Show formulas', 'Show Formulas'] },
        { label: 'View Grid Lines', run: () => s().toggleView('gridlines'), checked: () => s().view.gridlines, aliases: ['Grid lines', 'Gridlines'] },
        { label: 'Comments', run: () => s().toggleView('comments'), checked: () => s().view.comments, aliases: ['Show all comments', 'View Comments'] },
        { label: 'Column/Row Highlighting', run: () => s().toggleView('crosshair'), checked: () => s().view.crosshair, aliases: ['Highlight row and column', 'Crosshair'] },
        'separator',
        { label: 'Sidebar', run: actions.toggleSidebar, aliases: ['Properties sidebar', 'Properties', 'Styles'] },
        { label: 'Function List', run: actions.functionList, aliases: ['Function list', 'Functions'] },
        'separator',
        { label: 'Freeze Cells', items: [
          { label: 'Freeze Rows and Columns', run: () => s().freeze(), checked: frozen, aliases: ['Freeze rows and columns', 'Freeze Panes'] },
          { label: 'Freeze First Row', run: () => s().freeze(1, 0), aliases: ['Freeze first row'] },
          { label: 'Freeze First Column', run: () => s().freeze(0, 1), aliases: ['Freeze first column'] },
          { label: 'Unfreeze', run: () => s().freeze(0, 0), enabled: frozen, aliases: ['Unfreeze Panes'] },
        ] },
        { label: 'Zoom', items: [
          { label: 'Entire Page', run: t.entirePage, aliases: ['Whole sheet', 'Fit all'] },
          { label: 'Page Width', run: t.pageWidth, aliases: ['Fit width'] },
          { label: 'Optimal View', run: t.zoomToSelection, aliases: ['Zoom to Selection', 'Fit selection'] },
          'separator',
          { label: 'Zoom In', run: () => t.setZoom(t.zoom() * 1.25), aliases: ['Larger'] },
          { label: 'Zoom Out', run: () => t.setZoom(t.zoom() / 1.25), aliases: ['Smaller'] },
          'separator',
          ...[50, 75, 100, 150, 200].map((n) => ({ label: `${n}%`, run: () => t.setZoom(n / 100), aliases: [`Zoom ${n}%`] })),
          'separator',
          { label: 'Zoom…', run: t.zoomDialog, aliases: ['Zoom and View Layout'] },
        ] },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Chart…', run: () => dialogs.chartDialog(s()), aliases: ['Insert Chart', 'Chart', 'Graph', 'Pie chart', 'Bar chart', 'Line chart'] },
        { label: 'Export Chart as Image…', run: actions.exportChart, enabled: () => Boolean(s().chosenChart), aliases: ['Export chart as image…', 'Export as Image', 'Save chart as picture'] },
        { label: 'Pivot Table…', run: () => editPivot(s()), aliases: ['Pivot table…', 'DataPilot', 'Insert Pivot Table', 'Crosstab'] },
        'separator',
        { label: 'Function…', shortcut: 'Ctrl+F2', run: actions.functionList, aliases: ['Function', 'Function Wizard', 'Insert Function'] },
        { label: 'Named Range or Expression…', run: () => dialogs.namesDialog(s()), aliases: ['Named range…', 'Define Name', 'Define'] },
        'separator',
        { label: 'Hyperlink…', run: () => dialogs.hyperlinkDialog(s()), aliases: ['Insert Hyperlink', 'Link', 'URL'] },
        { label: 'Comment', shortcut: 'Ctrl+Alt+C', run: () => dialogs.commentDialog(s()), aliases: ['Insert Comment', 'Note', 'Annotation'] },
        'separator',
        { label: 'Special Character…', run: t.special, aliases: ['Symbol', 'Insert Special Character', 'Character map'] },
        { label: 'Formatting Mark', items: marks },
        'separator',
        { label: 'Date', run: actions.insertDate, shortcut: 'Ctrl+;', aliases: ['Insert Current Date', 'Today'] },
        { label: 'Time', run: actions.insertTime, shortcut: 'Ctrl+Shift+;', aliases: ['Insert Current Time', 'Now'] },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Text', items: [
          { label: 'Bold', shortcut: 'Ctrl+B', run: () => s().toggleLook('bold'), checked: () => Boolean(here().bold) },
          { label: 'Italic', shortcut: 'Ctrl+I', run: () => s().toggleLook('italic'), checked: () => Boolean(here().italic) },
          { label: 'Single Underline', shortcut: 'Ctrl+U', run: () => s().toggleLook('underline'), checked: () => Boolean(here().underline), aliases: ['Underline'] },
          { label: 'Double Underline', run: () => s().toggleLook('double'), checked: () => Boolean(here().double) },
          { label: 'Strikethrough', run: () => s().toggleLook('strike'), checked: () => Boolean(here().strike) },
          { label: 'Overline', run: () => s().toggleLook('overline'), checked: () => Boolean(here().overline) },
          'separator',
          { label: 'Shadow', run: () => s().toggleLook('shadow'), checked: () => Boolean(here().shadow) },
          { label: 'Outline Font Effect', run: () => s().toggleLook('outline'), checked: () => Boolean(here().outline), aliases: ['Outline'] },
          'separator',
          { label: 'Increase Size', shortcut: 'Ctrl+]', run: () => t.resize(1), aliases: ['Grow font'] },
          { label: 'Decrease Size', shortcut: 'Ctrl+[', run: () => t.resize(-1), aliases: ['Shrink font'] },
          'separator',
          { label: 'UPPERCASE', run: () => t.textCase('upper'), aliases: ['Upper case', 'Change case'] },
          { label: 'lowercase', run: () => t.textCase('lower'), aliases: ['Lower case'] },
          { label: 'Cycle Case', shortcut: 'Shift+F3', run: () => t.textCase('cycle') },
          { label: 'Sentence case', run: () => t.textCase('sentence') },
          { label: 'Capitalize Every Word', run: () => t.textCase('title'), aliases: ['Title case'] },
          { label: 'tOGGLE cASE', run: () => t.textCase('toggle'), aliases: ['Toggle case'] },
        ] },
        { label: 'Align Text', items: [
          { label: 'Left', run: () => s().formatCells({ align: 'left' }), checked: () => here().align === 'left', aliases: ['Align left', 'Align Left'] },
          { label: 'Centered', run: () => s().formatCells({ align: 'center' }), checked: () => here().align === 'center', aliases: ['Centre', 'Align Center', 'Center Horizontally'] },
          { label: 'Right', run: () => s().formatCells({ align: 'right' }), checked: () => here().align === 'right', aliases: ['Align right', 'Align Right'] },
          { label: 'Justified', run: () => s().formatCells({ align: 'justify' }), checked: () => here().align === 'justify', aliases: ['Justify'] },
          'separator',
          { label: 'Top', run: () => s().formatCells({ valign: 'top' }), checked: () => here().valign === 'top', aliases: ['Align top', 'Align Top'] },
          { label: 'Center', run: () => s().formatCells({ valign: 'middle' }), checked: () => here().valign === 'middle', aliases: ['Centre vertically', 'Center Vertically'] },
          { label: 'Bottom', run: () => s().formatCells({ valign: 'bottom' }), checked: () => here().valign === 'bottom', aliases: ['Align bottom', 'Align Bottom'] },
          'separator',
          { label: 'Wrap Text Automatically', run: () => s().toggleLook('wrap'), checked: () => Boolean(here().wrap), aliases: ['Wrap text', 'Wrap Text'] },
        ] },
        { label: 'Number Format', items: [
          { label: 'General', shortcut: 'Ctrl+Shift+6', run: () => s().setNumberFormat(null), aliases: ['Number format: general', 'Standard', 'Format as General'] },
          { label: 'Scientific', run: () => s().setNumberFormat('0.00E+00'), aliases: ['Number format: scientific', 'Format as Scientific'] },
          { label: 'Thousands Separator', run: () => s().setNumberFormat('#,##0'), aliases: ['Number format: thousands separator'] },
          { label: 'Date', run: () => s().setNumberFormat('yyyy-mm-dd'), aliases: ['Number format: date', 'Format as Date'] },
          { label: 'Time', run: () => s().setNumberFormat('hh:mm:ss'), aliases: ['Number format: time', 'Format as Time'] },
        ] },
        'separator',
        { label: 'Cells…', shortcut: 'Ctrl+1', run: () => dialogs.formatCellsDialog(s()), aliases: ['Format Cells', 'Font', 'Alignment', 'Background', 'Cell properties'] },
        { label: 'Rows', items: [
          { label: 'Height…', run: () => actions.askSize('row'), aliases: ['Row height…', 'Row Height'] },
          { label: 'Optimal Height', run: () => actions.bestSize('row'), aliases: ['Optimal row height', 'Optimal Row Height'] },
          'separator',
          { label: 'Hide', run: () => s().setHidden('row', true), aliases: ['Hide rows', 'Hide Rows'] },
          { label: 'Show', run: () => s().setHidden('row', false), aliases: ['Show rows', 'Show Rows', 'Unhide rows'] },
        ] },
        { label: 'Columns', items: [
          { label: 'Width…', run: () => actions.askSize('col'), aliases: ['Column width…', 'Column Width'] },
          { label: 'Optimal Width', run: () => actions.bestSize('col'), aliases: ['Optimal column width', 'Optimal Column Width', 'AutoFit'] },
          'separator',
          { label: 'Hide', run: () => s().setHidden('col', true), aliases: ['Hide columns', 'Hide Columns'] },
          { label: 'Show', run: () => s().setHidden('col', false), aliases: ['Show columns', 'Show Columns', 'Unhide columns'] },
        ] },
        { label: 'Merge and Unmerge Cells', items: [
          { label: 'Merge Cells', run: () => dialogs.mergeCells(s()), enabled: many, aliases: ['Merge cells', 'Merge and Center Cells'] },
          { label: 'Unmerge Cells', run: () => s().unmerge(), aliases: ['Unmerge cells', 'Split Cells'] },
        ] },
        { label: 'Borders', items: [
          { label: 'All Borders', run: () => s().setBorders('all'), aliases: ['All borders'] },
          { label: 'Outer Border', run: () => s().setBorders('outline'), aliases: ['Outside borders', 'Box border'] },
          { label: 'Bottom Border', run: () => s().setBorders('bottom'), aliases: ['Bottom border'] },
          { label: 'No Borders', run: () => s().setBorders('none'), aliases: ['No borders', 'Remove borders'] },
        ] },
        'separator',
        { label: 'Clone Formatting', run: actions.cloneFormatting, aliases: ['Clone formatting', 'Format Paintbrush', 'Paint format'] },
        { label: 'Clear Direct Formatting', shortcut: 'Ctrl+M', run: () => s().clearDirectFormatting(), aliases: ['Clear direct formatting', 'Clear formats'] },
        'separator',
        { label: 'Conditional…', run: () => dialogs.conditionalDialog(s()), aliases: ['Conditional formatting…', 'Conditional Formatting', 'Condition', 'Color Scale', 'Data Bar', 'Manage conditional formatting'] },
        'separator',
        { label: 'Print Ranges', items: [
          { label: 'Define', run: actions.setPrintArea, aliases: ['Set print area', 'Print Ranges Define', 'Set the print area to the selection'] },
          { label: 'Clear', run: actions.clearPrintArea, aliases: ['Clear print area', 'Print Ranges Clear'] },
          { label: 'Repeat Rows on Every Page', run: actions.repeatRows, aliases: ['Repeat rows on every page', 'Rows to repeat', 'Print titles'] },
        ] },
      ],
    },
    {
      label: 'Styles',
      items: [
        { label: 'Manage Styles', shortcut: 'F11', run: () => dialogs.stylesDialog(s()), aliases: ['Styles…', 'New Style from Selection', 'Update Selected Style', 'Cell Styles'] },
      ],
    },
    {
      label: 'Sheet',
      items: [
        { label: 'Insert Cells…', shortcut: 'Ctrl++', run: () => dialogs.insertCellsDialog(s()), aliases: ['Cells…'] },
        { label: 'Insert Rows', items: [
          { label: 'Rows Above', run: () => s().insertRows(s().selection.top, rows()), aliases: ['Rows above', 'Insert Rows Above', 'Insert row'] },
          { label: 'Rows Below', run: () => s().insertRows(s().selection.bottom + 1, rows()), aliases: ['Rows below', 'Insert Rows Below'] },
        ] },
        { label: 'Insert Columns', items: [
          { label: 'Columns Before', run: () => s().insertColumns(s().selection.left, cols()), aliases: ['Columns before', 'Insert Columns Before', 'Insert column'] },
          { label: 'Columns After', run: () => s().insertColumns(s().selection.right + 1, cols()), aliases: ['Columns after', 'Insert Columns After'] },
        ] },
        { label: 'Insert Page Break', items: [
          { label: 'Row Break', run: () => s().toggleRowBreak(), aliases: ['Page break above this row', 'Insert Row Break'] },
          { label: 'Column Break', run: () => s().toggleColumnBreak(), aliases: ['Page break left of this column', 'Insert Column Break'] },
        ] },
        'separator',
        { label: 'Delete Cells…', shortcut: 'Ctrl+-', run: () => dialogs.deleteCellsDialog(s()), aliases: ['Delete cells…'] },
        { label: 'Delete Rows', run: () => s().deleteRows(s().selection.top, rows()), aliases: ['Delete rows', 'Delete row'] },
        { label: 'Delete Columns', run: () => s().deleteColumns(s().selection.left, cols()), aliases: ['Delete columns', 'Delete column'] },
        { label: 'Delete Page Break', items: [
          { label: 'Remove All Page Breaks', run: actions.removeBreaks, aliases: ['Remove page breaks'] },
        ] },
        'separator',
        { label: 'Insert Sheet at End', run: () => s().addSheet(), aliases: ['Insert sheet', 'Insert Sheet', 'Sheet', 'Add sheet'] },
        { label: 'Delete Sheet…', run: () => sheets.deleteSheetDialog(s(), s().sheetId), enabled: () => s().model.sheets.length > 1, aliases: ['Delete sheet…'] },
        { label: 'Rename Sheet…', run: () => sheets.renameSheetDialog(s(), s().sheetId, toast), aliases: ['Rename sheet…'] },
        { label: 'Show Sheet…', run: () => sheets.showSheetsDialog(s(), toast), enabled: () => s().model.sheets.some((x) => x.hidden), aliases: ['Show sheets…', 'Unhide sheet'] },
        { label: 'Hide Sheet', run: () => s().setSheetHidden(s().sheetId, true), enabled: () => s().model.sheets.filter((x) => !x.hidden).length > 1, aliases: ['Hide sheet'] },
        { label: 'Move or Copy Sheet…', run: () => sheets.moveCopySheetDialog(s(), s().sheetId), aliases: ['Move or copy sheet…', 'Move sheet'] },
        { label: 'Duplicate Sheet', run: () => s().moveSheet(s().sheetId, null, { copy: true }), aliases: ['Duplicate sheet', 'Copy sheet'] },
        { label: 'Navigate', items: [
          { label: 'Go to Sheet…', run: () => sheets.goToSheetDialog(s()), aliases: ['Go to sheet…'] },
          { label: 'To Next Sheet', shortcut: 'Ctrl+PageDown', run: () => s().stepSheet(1), aliases: ['Next sheet'] },
          { label: 'To Previous Sheet', shortcut: 'Ctrl+PageUp', run: () => s().stepSheet(-1), aliases: ['Previous sheet'] },
        ] },
        { label: 'Sheet Tab Color…', run: () => sheets.tabColourDialog(s(), s().sheetId), aliases: ['Tab colour…', 'Tab color'] },
        'separator',
        { label: 'Fill Cells', items: [
          { label: 'Fill Down', shortcut: 'Ctrl+D', run: () => s().fillDown(), aliases: ['Fill down', 'Fill Cells Down'] },
          { label: 'Fill Right', run: () => s().fill('right'), aliases: ['Fill right'] },
          { label: 'Fill Up', run: () => s().fill('up'), aliases: ['Fill up'] },
          { label: 'Fill Left', run: () => s().fill('left'), aliases: ['Fill left'] },
          'separator',
          { label: 'Fill Series…', run: () => dialogs.seriesDialog(s()), aliases: ['Fill series…', 'Fill Cells Series'] },
          { label: 'Fill Random Number…', run: () => dialogs.randomDialog(s()), aliases: ['Fill random numbers…', 'Random numbers'] },
        ] },
        { label: 'Named Ranges and Expressions', items: [
          { label: 'Manage…', shortcut: 'Ctrl+F3', run: () => dialogs.namesDialog(s()), aliases: ['Named range…', 'Manage Names', 'Name Manager'] },
          { label: 'Create…', run: () => dialogs.namesFromLabelsDialog(s()), aliases: ['Names from labels…', 'Create Names', 'Create from selection', 'Labels'] },
        ] },
        { label: 'Remove Hyperlink', run: () => s().setLink(null), enabled: () => Boolean(s().linkAt(s().active.row, s().active.col)), aliases: ['Remove link', 'Unlink'] },
        { label: 'Cell Comment', items: [
          { label: 'Edit Comment', run: () => dialogs.commentDialog(s()), enabled: () => Boolean(s().noteAt(s().active.row, s().active.col)) },
          { label: 'Show Comment', run: () => s().setNoteShown(!s().sheet.cell(s().active.row, s().active.col)?.ns), checked: () => Boolean(s().sheet.cell(s().active.row, s().active.col)?.ns), enabled: () => Boolean(s().noteAt(s().active.row, s().active.col)), aliases: ['Hide Comment'] },
          { label: 'Delete Comment', run: () => s().deleteNotes(), aliases: ['Delete Comments', 'Remove comment'] },
        ] },
        'separator',
        { label: 'Delete Contents', shortcut: 'Delete', run: () => s().clearSelection(), aliases: ['Clear contents', 'Clear Cells'] },
        { label: 'Cycle Cell Reference Types', shortcut: 'F4', run: actions.cycleReference, aliases: ['Cycle reference types', 'Absolute reference'] },
      ],
    },
    {
      label: 'Data',
      items: [
        { label: 'Sort…', run: () => dialogs.sortDialog(s()), aliases: ['Sort', 'Custom sort'] },
        { label: 'Sort Ascending', run: () => sortBy(s(), 1), aliases: ['Sort ascending', 'Sort A to Z'] },
        { label: 'Sort Descending', run: () => sortBy(s(), -1), aliases: ['Sort descending', 'Sort Z to A'] },
        { label: 'AutoFilter', shortcut: 'Ctrl+Shift+L', run: () => dialogs.toggleAutoFilter(s()), checked: filtered, aliases: ['Filter', 'Hide AutoFilter'] },
        { label: 'More Filters', items: [
          { label: 'Standard Filter…', run: () => dialogs.standardFilterDialog(s()), aliases: ['Standard filter…', 'Advanced filter'] },
          { label: 'Reset Filter', run: () => s().setFilter(null), enabled: filtered, aliases: ['Reset filter', 'Clear filter', 'Clear AutoFilter'] },
        ] },
        'separator',
        { label: 'Calculate', items: [
          { label: 'Recalculate Hard', shortcut: 'Ctrl+Shift+F9', run: () => s().recalculateHard(), aliases: ['Recalculate hard', 'Recalculate'] },
          { label: 'Formula to Value', run: () => s().formulasToValues(), aliases: ['Formulas to values', 'Paste values'] },
        ] },
        { label: 'Pivot Table', items: [
          { label: 'Insert or Edit…', run: () => editPivot(s()), aliases: ['Pivot table…', 'Edit Layout', 'Pivot Table Properties'] },
          { label: 'Refresh', run: () => s().refreshPivots(), aliases: ['Refresh pivot tables', 'Refresh Pivot Table', 'Recalculate pivot'] },
          { label: 'Delete', run: () => { const p = here(s()); if (p) s().deletePivot(p.id); }, enabled: () => Boolean(here(s())), aliases: ['Delete pivot table', 'Delete Pivot Table'] },
        ] },
        'separator',
        { label: 'Validity…', run: () => dialogs.validityDialog(s()), aliases: ['Validity', 'Data validation', 'Selection list', 'Drop-down list'] },
        { label: 'Subtotals…', run: () => dialogs.subtotalsDialog(s()), aliases: ['Subtotals'] },
        'separator',
        { label: 'Text to Columns…', run: () => dialogs.textToColumnsDialog(s()), aliases: ['Text to columns…', 'Split text'] },
        { label: 'Duplicates…', run: () => toast(`${s().removeDuplicates()} repeated row(s) removed`), aliases: ['Remove duplicates', 'Handle Duplicate Records'] },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'Spelling…', shortcut: 'F7', run: actions.spelling, aliases: ['Spellcheck', 'Check spelling'] },
        'separator',
        { label: 'Redact', run: () => s().toggleRedact(), aliases: ['Cover cells', 'Black out'] },
        { label: 'Auto-Redact…', run: actions.autoRedact, aliases: ['Find sensitive data', 'Redact automatically'] },
        'separator',
        { label: 'Goal Seek…', run: () => dialogs.goalSeekDialog(s(), toast), aliases: ['Goal seek', 'What-if'] },
        { label: 'Solver…', run: () => dialogs.solverDialog(s(), toast), aliases: ['Solver', 'Optimise', 'Linear programming'] },
        'separator',
        { label: 'AutoInput', run: actions.toggleAutoInput, checked: actions.autoInputOn, aliases: ['Autocomplete'] },
        'separator',
        { label: 'Customize…', run: actions.customize, aliases: ['Customize', 'Keyboard shortcuts', 'Shortcut keys', 'Key bindings'] },
        { label: 'Options…', run: actions.settings, aliases: ['Settings…', 'Settings', 'Preferences'] },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'About GRT Grid', run: actions.about, aliases: ['About', 'About %PRODUCTNAME'] },
        { label: 'Licences', run: actions.licences, aliases: ['License Information', 'Licenses'] },
      ],
    },
  ];
}

const here = (sheet) => sheet.pivotAt(sheet.active.row, sheet.active.col);

/** Edits the pivot table under the cell, or makes one from the data around it. */
function editPivot(sheet) {
  return dialogs.pivotDialog(sheet, here(sheet));
}

/** Sorts the data around the cell by the cell's column. */
function sortBy(sheet, order) {
  const area = sheet.dataArea();
  sheet.sort({ area, keys: [{ index: sheet.active.col - area.left, order }] });
}
