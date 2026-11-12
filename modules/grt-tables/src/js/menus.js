/** Tables' menus; each item names what LibreOffice Base calls it, so the palette finds it by those names. */

/**
 * @param {{actions: Object, view: () => string, has: Object<string, () => boolean>}} app
 */
export function tablesMenus({ actions, view, has }) {
  const viewItem = (name, label) => ({ label, run: () => actions.setView(name), checked: () => view() === name });
  return [
    {
      label: 'File',
      items: [
        { label: 'New database…', run: actions.newDatabase, aliases: ['New', 'Database Wizard'] },
        { label: 'Open…', shortcut: 'Ctrl+O', run: actions.open, aliases: ['Open database', 'Open Base file', 'Open .odb'] },
        { label: 'Close', run: actions.close },
        'separator',
        { label: 'Import CSV or a spreadsheet…', run: actions.importFile, aliases: ['Import', 'Copy table from spreadsheet'] },
        { label: 'Export as a spreadsheet or CSV…', run: actions.exportData, aliases: ['Export'] },
        { label: 'Save as a Base database (.odb)…', run: actions.exportOdb, aliases: ['Save As', 'LibreOffice Base', 'odb'] },
        { label: 'Report as a text document…', run: actions.reportToText, enabled: has.report, aliases: ['Report to Text Document', 'Send report'] },
        'separator',
        { label: 'Export readable archive…', run: actions.exportArchive },
        { label: 'Import readable archive…', run: actions.importArchive },
        'separator',
        { label: 'Print…', shortcut: 'Ctrl+P', run: actions.print },
        { label: 'Prepare for sharing', run: actions.prepareForSharing },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: actions.undo },
        'separator',
        { label: 'Cut table', run: actions.cutTable, enabled: has.table, aliases: ['Cut'] },
        { label: 'Copy table', run: actions.copyTable, enabled: has.table, aliases: ['Copy'] },
        { label: 'Paste table…', run: actions.pasteTable, enabled: has.copied, aliases: ['Paste', 'Paste Special', 'Copy Table wizard'] },
        { label: 'Select all rows', run: actions.selectAll, enabled: has.table, aliases: ['Select All'] },
        { label: 'Search Everywhere…', run: actions.everywhere, aliases: ['Search everywhere', 'Search in files', 'Find in folder', 'Search all documents'] },
        { label: 'Copy rows as text', run: actions.copyRows, enabled: has.table },
        'separator',
        { label: 'Rename…', run: actions.rename, enabled: has.selected, aliases: ['Rename table', 'Rename query', 'Rename form', 'Rename report'] },
        { label: 'Delete…', run: actions.remove, enabled: has.selected, aliases: ['Delete table', 'Delete query', 'Delete form', 'Delete report'] },
        'separator',
        { label: 'Edit in SQL view', run: () => actions.setView('query'), aliases: ['Edit query'] },
        { label: 'Create as view…', run: actions.saveView, aliases: ['Create View', 'Save query as view'] },
      ],
    },
    {
      label: 'View',
      items: [
        viewItem('data', 'Data'),
        viewItem('design', 'Design'),
        viewItem('query', 'Query'),
        viewItem('form', 'Form'),
        viewItem('report', 'Report'),
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Table…', run: actions.newTable, aliases: ['New table', 'Table Design', 'Table Wizard'] },
        { label: 'Query…', run: () => actions.setView('query'), aliases: ['New query', 'Query (SQL View)'] },
        { label: 'Save query…', run: actions.saveQuery, aliases: ['Save query'] },
        'separator',
        { label: 'Form…', run: actions.formWizard, aliases: ['New form', 'Form Wizard'] },
        { label: 'Report…', run: actions.reportWizard, aliases: ['New report', 'Report Wizard'] },
        'separator',
        { label: 'Row', run: actions.addRow, enabled: has.table, aliases: ['Add row', 'New record'] },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'Settings…', run: actions.settings, aliases: ['Options', 'Preferences'] },
      ],
    },
  ];
}
