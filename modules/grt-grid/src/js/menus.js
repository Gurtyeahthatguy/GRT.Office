/** Grid's menus; each item names what LibreOffice and Excel call it, so the palette finds it by those names. */

import * as dialogs from './dialogs.js';
import * as sheets from './sheets.js';

/**
 * @param {{sheet: () => import('./controller.js').SheetController, actions: Object, toast: Function}} app
 */
export function gridMenus({ sheet, actions, toast }) {
  const s = () => sheet();
  const many = () => !s().selectionIsSingle;
  const filtered = () => Boolean(s().sheet.filter);
  const frozen = () => Boolean(s().sheet.frozen?.rows || s().sheet.frozen?.cols);
  const rows = () => s().selection.bottom - s().selection.top + 1;
  const cols = () => s().selection.right - s().selection.left + 1;

  return [
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', run: actions.newFile, aliases: ['New spreadsheet'] },
        { label: 'Open…', shortcut: 'Ctrl+O', run: actions.open },
        'separator',
        { label: 'Save', shortcut: 'Ctrl+S', run: actions.save },
        { label: 'Save as…', shortcut: 'Ctrl+Shift+S', run: actions.saveAs },
        { label: 'Save a copy…', run: actions.saveCopy, aliases: ['Save a Copy'] },
        { label: 'Templates…', shortcut: 'Ctrl+Shift+N', run: actions.templates, aliases: ['Manage Templates', 'Templates', 'New from template'] },
        { label: 'Save as template…', run: actions.saveTemplate, aliases: ['Save as Template', 'Edit Template'] },
        { label: 'Reload', run: actions.reload, aliases: ['Reload', 'Revert'] },
        'separator',
        { label: 'Import CSV…', run: actions.importCsv, aliases: ['Text CSV', 'Open CSV'] },
        { label: 'Export CSV…', run: actions.exportCsv },
        { label: 'Export PDF…', run: actions.exportPdf, aliases: ['Export as PDF', 'Export directly as PDF'] },
        'separator',
        { label: 'Print…', shortcut: 'Ctrl+P', run: actions.print, aliases: ['Print preview'] },
        { label: 'Settings…', run: actions.settings, aliases: ['Options', 'Preferences'] },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: () => s().step(-1), enabled: () => s().undo.canUndo },
        { label: 'Redo', shortcut: 'Ctrl+Y', run: () => s().step(1), enabled: () => s().undo.canRedo },
        'separator',
        { label: 'Find and replace…', shortcut: 'Ctrl+H', run: () => dialogs.findReplaceDialog(s(), toast), aliases: ['Find & Replace', 'Search', 'Replace', 'Find Toolbar', 'vnd.sun.star.findbar:FocusToFindbar'] },
        'separator',
        { label: 'Select row', run: () => s().selectWhole('row'), aliases: ['Select Row'] },
        { label: 'Select column', run: () => s().selectWhole('col'), aliases: ['Select Column'] },
        { label: 'Select data area', shortcut: 'Ctrl+*', run: () => s().selectDataArea(), aliases: ['Select Data Area', 'Current region'] },
        { label: 'Cycle reference types', shortcut: 'F4', run: actions.cycleReference, aliases: ['Cycle Cell Reference Types', 'Absolute reference'] },
        { label: 'AutoInput', run: actions.toggleAutoInput, checked: actions.autoInputOn, aliases: ['AutoInput', 'Autocomplete'] },
        'separator',
        { label: 'Fill down', shortcut: 'Ctrl+D', run: () => s().fillDown(), aliases: ['Fill Cells Down', 'Fill Down'] },
        { label: 'Fill right', run: () => s().fill('right'), aliases: ['Fill Right'] },
        { label: 'Fill up', run: () => s().fill('up'), aliases: ['Fill Up'] },
        { label: 'Fill left', run: () => s().fill('left'), aliases: ['Fill Left'] },
        { label: 'Fill series…', run: () => dialogs.seriesDialog(s()), aliases: ['Fill Series', 'Fill Cells Series'] },
        { label: 'Fill random numbers…', run: () => dialogs.randomDialog(s()), aliases: ['Fill Random Number', 'Random numbers'] },
        'separator',
        { label: 'Delete cells…', shortcut: 'Ctrl+-', run: () => dialogs.deleteCellsDialog(s()), aliases: ['Delete Cells'] },
        { label: 'Clear contents', shortcut: 'Delete', run: () => s().clearSelection(), aliases: ['Delete Contents', 'Clear Direct Formatting'] },
        { label: 'Paste special…', shortcut: 'Ctrl+Shift+V', run: actions.pasteSpecial, aliases: ['Paste Special'] },
        { label: 'Paste unformatted text', shortcut: 'Ctrl+Alt+Shift+V', run: actions.pasteUnformatted, aliases: ['Paste Unformatted Text', 'Paste as plain text'] },
        { label: 'Paste only text', run: () => actions.pasteSome({ numbers: false, formulas: false, formats: false }), aliases: ['Paste Only Text'] },
        { label: 'Paste only numbers', run: () => actions.pasteSome({ text: false, formulas: false, formats: false }), aliases: ['Paste Only Numbers'] },
        { label: 'Paste only formulas', run: () => actions.pasteSome({ text: false, numbers: false, formats: false }), aliases: ['Paste Only Formula'] },
        { label: 'Paste transposed', run: () => actions.pasteSome({ transpose: true }), aliases: ['Paste Transposed', 'Transpose'] },
        { label: 'Formulas to values', run: () => s().formulasToValues(), aliases: ['Formula to Value', 'Paste values'] },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Freeze rows and columns', run: () => s().freeze(), checked: frozen, aliases: ['Freeze Cells', 'Freeze Panes'] },
        { label: 'Freeze first row', run: () => s().freeze(1, 0), aliases: ['Freeze First Row'] },
        { label: 'Freeze first column', run: () => s().freeze(0, 1), aliases: ['Freeze First Column'] },
        { label: 'Unfreeze', run: () => s().freeze(0, 0), enabled: frozen, aliases: ['Unfreeze Panes'] },
        'separator',
        { label: 'Properties sidebar', run: actions.toggleSidebar, aliases: ['Sidebar', 'Properties', 'Styles'] },
        { label: 'Function list', run: actions.functionList, aliases: ['Function List', 'Functions'] },
        'separator',
        { label: 'Show formulas', shortcut: 'Ctrl+`', run: () => s().toggleView('formulas'), checked: () => s().view.formulas, aliases: ['Show Formulas', 'Show Formula'] },
        { label: 'Grid lines', run: () => s().toggleView('gridlines'), checked: () => s().view.gridlines, aliases: ['View Grid Lines', 'Gridlines'] },
        { label: 'Highlight row and column', run: () => s().toggleView('crosshair'), checked: () => s().view.crosshair, aliases: ['Column/Row Highlighting', 'Crosshair'] },
        { label: 'Value highlighting', shortcut: 'Ctrl+F8', run: () => s().toggleView('values'), checked: () => s().view.values, aliases: ['Value Highlighting'] },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Cells…', shortcut: 'Ctrl++', run: () => dialogs.insertCellsDialog(s()), aliases: ['Insert Cells'] },
        { label: 'Rows above', run: () => s().insertRows(s().selection.top, rows()), aliases: ['Insert Rows Above', 'Insert row'] },
        { label: 'Rows below', run: () => s().insertRows(s().selection.bottom + 1, rows()), aliases: ['Insert Rows Below'] },
        { label: 'Columns before', run: () => s().insertColumns(s().selection.left, cols()), aliases: ['Insert Columns Before', 'Insert column'] },
        { label: 'Columns after', run: () => s().insertColumns(s().selection.right + 1, cols()), aliases: ['Insert Columns After'] },
        'separator',
        { label: 'Sheet', run: () => s().addSheet(), aliases: ['Insert Sheet', 'Add sheet'] },
        { label: 'Pivot table…', run: () => editPivot(s()), aliases: ['Pivot Table', 'DataPilot', 'Insert Pivot Table', 'Crosstab'] },
        { label: 'Chart…', run: () => dialogs.chartDialog(s()), aliases: ['Insert Chart', 'Chart', 'Graph', 'Pie chart', 'Bar chart', 'Line chart'] },
        { label: 'Export chart as image…', run: actions.exportChart, enabled: () => Boolean(s().chosenChart), aliases: ['Export as Image', 'Save chart as picture'] },
        { label: 'Named range…', shortcut: 'Ctrl+F3', run: () => dialogs.namesDialog(s()), aliases: ['Named Ranges and Expressions', 'Define Name', 'Manage Names', 'Name Manager', 'Named Range or Expression', 'Define', 'Manage'] },
        { label: 'Function…', shortcut: 'Ctrl+F2', run: actions.functionList, aliases: ['Function', 'Function Wizard', 'Insert Function'] },
        { label: 'Date', run: actions.insertDate, shortcut: 'Ctrl+;', aliases: ['Insert Current Date', 'Today'] },
        { label: 'Time', run: actions.insertTime, shortcut: 'Ctrl+Shift+;', aliases: ['Insert Current Time', 'Now'] },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Cells…', shortcut: 'Ctrl+1', run: () => dialogs.formatCellsDialog(s()), aliases: ['Format Cells', 'Number Format', 'Font', 'Alignment', 'Background', 'Cell properties'] },
        { label: 'Styles…', shortcut: 'F11', run: () => dialogs.stylesDialog(s()), aliases: ['Manage Styles', 'New Style from Selection', 'Update Selected Style', 'Cell Styles'] },
        { label: 'Clear direct formatting', shortcut: 'Ctrl+M', run: () => s().clearDirectFormatting(), aliases: ['Clear Direct Formatting', 'Clear formats'] },
        'separator',
        { label: 'Bold', shortcut: 'Ctrl+B', run: () => s().toggleLook('bold') },
        { label: 'Italic', shortcut: 'Ctrl+I', run: () => s().toggleLook('italic') },
        { label: 'Underline', shortcut: 'Ctrl+U', run: () => s().toggleLook('underline') },
        { label: 'Strikethrough', run: () => s().toggleLook('strike') },
        { label: 'Wrap text', run: () => s().toggleLook('wrap'), aliases: ['Wrap Text Automatically'] },
        { label: 'Clone formatting', run: actions.cloneFormatting, aliases: ['Clone Formatting', 'Format Paintbrush', 'Paint format'] },
        'separator',
        { label: 'Number format: general', shortcut: 'Ctrl+Shift+6', run: () => s().setNumberFormat(null), aliases: ['General', 'Standard', 'Format as General'] },
        { label: 'Number format: scientific', run: () => s().setNumberFormat('0.00E+00'), aliases: ['Scientific', 'Format as Scientific'] },
        { label: 'Number format: thousands separator', run: () => s().setNumberFormat('#,##0'), aliases: ['Thousands Separator'] },
        { label: 'Number format: date', run: () => s().setNumberFormat('yyyy-mm-dd'), aliases: ['Format as Date', 'Date'] },
        { label: 'Number format: time', run: () => s().setNumberFormat('hh:mm:ss'), aliases: ['Format as Time', 'Time'] },
        'separator',
        { label: 'Align left', run: () => s().formatCells({ align: 'left' }), aliases: ['Align Left'] },
        { label: 'Centre', run: () => s().formatCells({ align: 'center' }), aliases: ['Align Center', 'Center Horizontally'] },
        { label: 'Align right', run: () => s().formatCells({ align: 'right' }), aliases: ['Align Right'] },
        { label: 'Justify', run: () => s().formatCells({ align: 'justify' }), aliases: ['Justified', 'Justify'] },
        { label: 'Align top', run: () => s().formatCells({ valign: 'top' }), aliases: ['Top', 'Align Top'] },
        { label: 'Centre vertically', run: () => s().formatCells({ valign: 'middle' }), aliases: ['Center', 'Center Vertically'] },
        { label: 'Align bottom', run: () => s().formatCells({ valign: 'bottom' }), aliases: ['Bottom', 'Align Bottom'] },
        'separator',
        { label: 'All borders', run: () => s().setBorders('all'), aliases: ['Borders', 'All Borders'] },
        { label: 'Outside borders', run: () => s().setBorders('outline'), aliases: ['Outer Border', 'Box border'] },
        { label: 'Bottom border', run: () => s().setBorders('bottom'), aliases: ['Bottom Border'] },
        { label: 'No borders', run: () => s().setBorders('none'), aliases: ['No Borders', 'Remove borders'] },
        'separator',
        { label: 'Merge cells', run: () => dialogs.mergeCells(s()), enabled: many, aliases: ['Merge and Center Cells', 'Merge Cells'] },
        { label: 'Unmerge cells', run: () => s().unmerge(), aliases: ['Split Cells', 'Unmerge Cells'] },
        'separator',
        { label: 'Conditional formatting…', run: () => dialogs.conditionalDialog(s()), aliases: ['Conditional Formatting', 'Condition', 'Color Scale', 'Data Bar', 'Manage conditional formatting'] },
        'separator',
        { label: 'Hide rows', run: () => s().setHidden('row', true), aliases: ['Hide Rows'] },
        { label: 'Show rows', run: () => s().setHidden('row', false), aliases: ['Show Rows', 'Unhide rows'] },
        { label: 'Hide columns', run: () => s().setHidden('col', true), aliases: ['Hide Columns'] },
        { label: 'Show columns', run: () => s().setHidden('col', false), aliases: ['Show Columns', 'Unhide columns'] },
        'separator',
        { label: 'Row height…', run: () => actions.askSize('row'), aliases: ['Height', 'Row Height'] },
        { label: 'Optimal row height', run: () => actions.bestSize('row'), aliases: ['Optimal Height', 'Optimal Row Height'] },
        { label: 'Column width…', run: () => actions.askSize('col'), aliases: ['Width', 'Column Width'] },
        { label: 'Optimal column width', run: () => actions.bestSize('col'), aliases: ['Optimal Width', 'Optimal Column Width', 'AutoFit'] },
      ],
    },
    {
      label: 'Sheet',
      items: [
        { label: 'Insert sheet', run: () => s().addSheet(), aliases: ['Insert Sheet at End'] },
        { label: 'Rename sheet…', run: () => sheets.renameSheetDialog(s(), s().sheetId, toast), aliases: ['Rename Sheet'] },
        { label: 'Delete sheet…', run: () => sheets.deleteSheetDialog(s(), s().sheetId), enabled: () => s().model.sheets.length > 1, aliases: ['Delete Sheet'] },
        { label: 'Duplicate sheet', run: () => s().moveSheet(s().sheetId, null, { copy: true }), aliases: ['Duplicate Sheet', 'Copy sheet'] },
        { label: 'Move or copy sheet…', run: () => sheets.moveCopySheetDialog(s(), s().sheetId), aliases: ['Move or Copy Sheet', 'Move sheet'] },
        { label: 'Hide sheet', run: () => s().setSheetHidden(s().sheetId, true), enabled: () => s().model.sheets.filter((x) => !x.hidden).length > 1, aliases: ['Hide Sheet'] },
        { label: 'Show sheets…', run: () => sheets.showSheetsDialog(s(), toast), enabled: () => s().model.sheets.some((x) => x.hidden), aliases: ['Show Sheet', 'Unhide sheet'] },
        { label: 'Tab colour…', run: () => sheets.tabColourDialog(s(), s().sheetId), aliases: ['Sheet Tab Color', 'Tab color'] },
        'separator',
        { label: 'Go to sheet…', run: () => sheets.goToSheetDialog(s()), aliases: ['Go to Sheet', 'Navigate'] },
        { label: 'Next sheet', shortcut: 'Ctrl+PageDown', run: () => s().stepSheet(1), aliases: ['To Next Sheet'] },
        { label: 'Previous sheet', shortcut: 'Ctrl+PageUp', run: () => s().stepSheet(-1), aliases: ['To Previous Sheet'] },
        'separator',
        { label: 'Delete rows', run: () => s().deleteRows(s().selection.top, rows()), aliases: ['Delete Rows', 'Delete row'] },
        { label: 'Delete columns', run: () => s().deleteColumns(s().selection.left, cols()), aliases: ['Delete Columns', 'Delete column'] },
        'separator',
        { label: 'Set print area', run: actions.setPrintArea, aliases: ['Print Ranges Define', 'Set the print area to the selection'] },
        { label: 'Clear print area', run: actions.clearPrintArea, aliases: ['Print Ranges Clear'] },
        { label: 'Repeat rows on every page', run: actions.repeatRows, aliases: ['Rows to repeat', 'Print titles'] },
        { label: 'Page break above this row', run: () => s().toggleRowBreak(), aliases: ['Insert Row Break'] },
        { label: 'Page break left of this column', run: () => s().toggleColumnBreak(), aliases: ['Insert Column Break'] },
        { label: 'Remove page breaks', run: actions.removeBreaks, aliases: ['Delete Page Break'] },
      ],
    },
    {
      label: 'Data',
      items: [
        { label: 'Sort…', run: () => dialogs.sortDialog(s()), aliases: ['Sort', 'Custom sort'] },
        { label: 'Sort ascending', run: () => sortBy(s(), 1), aliases: ['Sort Ascending', 'Sort A to Z'] },
        { label: 'Sort descending', run: () => sortBy(s(), -1), aliases: ['Sort Descending', 'Sort Z to A'] },
        'separator',
        { label: 'AutoFilter', shortcut: 'Ctrl+Shift+L', run: () => dialogs.toggleAutoFilter(s()), checked: filtered, aliases: ['AutoFilter', 'Filter', 'Hide AutoFilter'] },
        { label: 'Standard filter…', run: () => dialogs.standardFilterDialog(s()), aliases: ['Standard Filter', 'Advanced filter'] },
        { label: 'Reset filter', run: () => s().setFilter(null), enabled: filtered, aliases: ['Reset Filter', 'Clear filter', 'Clear AutoFilter'] },
        'separator',
        { label: 'Pivot table…', run: () => editPivot(s()), aliases: ['Edit Layout', 'Pivot Table Properties', 'Insert or Edit'] },
        { label: 'Refresh pivot tables', run: () => s().refreshPivots(), aliases: ['Refresh', 'Refresh Pivot Table', 'Recalculate pivot'] },
        { label: 'Delete pivot table', run: () => { const p = here(s()); if (p) s().deletePivot(p.id); }, enabled: () => Boolean(here(s())), aliases: ['Delete Pivot Table', 'Delete'] },
        { label: 'Recalculate hard', shortcut: 'Ctrl+Shift+F9', run: () => s().recalculateHard(), aliases: ['Recalculate Hard', 'Recalculate'] },
        'separator',
        { label: 'Validity…', run: () => dialogs.validityDialog(s()), aliases: ['Validity', 'Data validation', 'Selection list', 'Drop-down list'] },
        { label: 'Subtotals…', run: () => dialogs.subtotalsDialog(s()), aliases: ['Subtotals'] },
        'separator',
        { label: 'Remove duplicates', run: () => toast(`${s().removeDuplicates()} repeated row(s) removed`), aliases: ['Duplicates', 'Handle Duplicate Records'] },
        { label: 'Text to columns…', run: () => dialogs.textToColumnsDialog(s()), aliases: ['Text to Columns', 'Split text'] },
        { label: 'Names from labels…', run: () => dialogs.namesFromLabelsDialog(s()), aliases: ['Create Names', 'Create from selection', 'Create', 'Labels'] },
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
