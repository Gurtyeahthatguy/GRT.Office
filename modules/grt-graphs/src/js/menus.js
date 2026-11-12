/** Graphs' menus, in the order and with the names of LibreOffice Draw; the palette lists the same commands. */

/**
 * @param {Object} a the program's actions
 */
export function graphsMenus(a) {
  const t = a.tools;
  return [
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', run: a.newFile, aliases: ['New diagram', 'New Drawing'] },
        { label: 'Open…', shortcut: 'Ctrl+O', run: a.open },
        { label: 'Templates', items: [
          { label: 'Manage Templates…', shortcut: 'Ctrl+Shift+N', run: a.templates, aliases: ['Templates…', 'Templates', 'New from template'] },
          { label: 'Save as Template…', run: a.saveTemplate, aliases: ['Save as template…', 'Edit Template'] },
        ] },
        { label: 'Reload', run: a.reload, aliases: ['Revert'] },
        'separator',
        { label: 'Save', shortcut: 'Ctrl+S', run: a.save },
        { label: 'Save As…', shortcut: 'Ctrl+Shift+S', run: a.saveAs, aliases: ['Save as…'] },
        { label: 'Save a Copy…', run: a.saveCopy, aliases: ['Save a copy…'] },
        'separator',
        { label: 'Import', items: [
          { label: 'Import JSON…', run: a.importJson },
          { label: 'Import Mermaid…', run: a.importMermaid, aliases: ['Mermaid'] },
        ] },
        { label: 'Export…', run: a.exportDocument, aliases: ['Export as SVG', 'Export as PNG', 'Export as PDF', 'Export'] },
        'separator',
        { label: 'Print…', shortcut: 'Ctrl+P', run: a.print },
        'separator',
        { label: 'Properties…', run: t.properties, aliases: ['Document properties', 'Statistics'] },
        { label: 'Inspect Document…', run: a.inspect, aliases: ['Document inspector', 'Remove personal information', 'Clean copy', 'Prepare for sharing'] },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: a.undo },
        { label: 'Redo', shortcut: 'Ctrl+Y', run: a.redo },
        'separator',
        { label: 'Select All', shortcut: 'Ctrl+A', run: a.selectAll, aliases: ['Select all'] },
        { label: 'Delete', shortcut: 'Delete', run: a.deleteSelection, aliases: ['Delete selection'] },
        'separator',
        { label: 'Find Toolbar', shortcut: 'Ctrl+F', run: () => t.bar.open(), aliases: ['Find', 'Search', 'vnd.sun.star.findbar:FocusToFindbar'] },
        { label: 'Search Everywhere…', run: a.everywhere, aliases: ['Search everywhere', 'Search in files', 'Find in folder', 'Search all documents'] },
        { label: 'Find and Replace…', shortcut: 'Ctrl+H', run: t.findReplace, aliases: ['Find & Replace', 'Replace'] },
        'separator',
        { label: 'Hyperlink', run: t.hyperlink, aliases: ['Edit Hyperlink', 'Edit link'] },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Comments', run: a.toggleComments, checked: a.commentsShown, aliases: ['Show comments'] },
        { label: 'Diagram as Text', run: a.diagramText, checked: a.diagramTextShown, aliases: ['Mermaid', 'Edit as text', 'Source'] },
        'separator',
        { label: 'Zoom', items: [
          { label: 'Zoom In', run: a.zoomIn, aliases: ['Larger'] },
          { label: 'Zoom Out', run: a.zoomOut, aliases: ['Smaller'] },
          { label: 'Optimal View', shortcut: 'Ctrl+0', run: a.fit, aliases: ['Fit to view', 'Entire Page', 'Page Width'] },
        ] },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Shape', shortcut: 'Insert', run: a.addNode, aliases: ['Add node', 'Node', 'Rectangle'] },
        'separator',
        { label: 'Comment', shortcut: 'Ctrl+Alt+C', run: () => t.comment(), aliases: ['Insert Comment', 'Note', 'Annotation'] },
        { label: 'Hyperlink…', run: t.hyperlink, aliases: ['Insert Hyperlink', 'Link', 'URL'] },
        { label: 'Special Character…', run: t.special, aliases: ['Symbol', 'Insert Special Character', 'Character map'] },
        { label: 'Formatting Mark', items: t.marks.map((m) => ({ label: m.label.replace(/^\w/, (c) => c.toUpperCase()), run: () => t.insertChars(m.char) })) },
        'separator',
        { label: 'Diagram from a Table…', run: a.diagramFromTable, aliases: ['Diagram from a table…', 'Organisation chart'] },
        { label: 'Live Value from Grid or Tables…', run: a.liveValue, aliases: ['Live value from Grid or Tables…'] },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Shape Type', items: ['rect', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'hexagon', 'triangle']
          .map((shape) => ({ label: shape[0].toUpperCase() + shape.slice(1), run: () => a.apply('shape', shape), aliases: [`Shape: ${shape}`] })) },
        { label: 'Connector', items: ['orthogonal', 'straight', 'curved']
          .map((routing) => ({ label: routing[0].toUpperCase() + routing.slice(1), run: () => a.apply('routing', routing), aliases: [`Routing: ${routing}`] })) },
      ],
    },
    {
      label: 'Shape',
      items: [
        { label: 'Align Objects', items: [
          { label: 'Left', run: () => a.align('left'), aliases: ['Align left'] },
          { label: 'Centered', run: () => a.align('centre-x'), aliases: ['Align centres horizontally'] },
          { label: 'Right', run: () => a.align('right'), aliases: ['Align right'] },
          { label: 'Top', run: () => a.align('top'), aliases: ['Align top'] },
          { label: 'Center', run: () => a.align('centre-y'), aliases: ['Align centres vertically'] },
          { label: 'Bottom', run: () => a.align('bottom'), aliases: ['Align bottom'] },
        ] },
        { label: 'Distribute Selection', items: [
          { label: 'Horizontally Center', run: () => a.distribute('horizontal'), aliases: ['Distribute horizontally'] },
          { label: 'Vertically Center', run: () => a.distribute('vertical'), aliases: ['Distribute vertically'] },
        ] },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'Spelling…', shortcut: 'F7', run: a.spelling, aliases: ['Spellcheck', 'Check spelling'] },
        'separator',
        { label: 'Tree Layout', run: a.layout, aliases: ['Tree layout', 'Auto layout', 'Arrange as a tree'] },
        { label: 'Check for Problems', run: a.validate, aliases: ['Check for problems', 'Validate'] },
        { label: 'Compare Diagram…', run: a.compare, aliases: ['Compare', 'Diff', 'Compare versions'] },
        { label: 'Clear Comparison', run: a.clearComparison, enabled: a.comparing },
        'separator',
        { label: 'Plan: Critical Path and Gantt…', run: a.plan, aliases: ['Plan: critical path and Gantt…'] },
        { label: 'Plan: Send Deadlines to Dates…', run: a.deadlines, aliases: ['Plan: send deadlines to Dates…'] },
        { label: 'Data Table…', run: a.dataTable, aliases: ['Data table…'] },
        { label: 'Refresh Values', run: a.refreshValues, aliases: ['Refresh values'] },
        'separator',
        { label: 'Customize…', run: a.customize, aliases: ['Customize', 'Keyboard shortcuts', 'Shortcut keys', 'Key bindings'] },
        { label: 'Options…', shortcut: 'Ctrl+,', run: a.settings, aliases: ['Settings…', 'Settings', 'Preferences'] },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'About GRT Graphs', run: a.about, aliases: ['About', 'About %PRODUCTNAME'] },
        { label: 'Licences', run: a.licences, aliases: ['License Information', 'Licenses'] },
      ],
    },
  ];
}
