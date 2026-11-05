/** Slides' menus; each item names what LibreOffice Impress calls it, so the palette finds it by those names. */

/**
 * @param {{a: Object<string, Function>, has: Object<string, () => boolean>}} app
 */
export function slidesMenus({ a, has }) {
  return [
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', run: a.newFile, aliases: ['New presentation'] },
        { label: 'Open…', shortcut: 'Ctrl+O', run: a.open },
        'separator',
        { label: 'Save', shortcut: 'Ctrl+S', run: a.save },
        { label: 'Save as…', shortcut: 'Ctrl+Shift+S', run: a.saveAs },
        { label: 'Save a copy…', run: a.saveCopy, aliases: ['Save a Copy'] },
        { label: 'Templates…', shortcut: 'Ctrl+Shift+N', run: a.templates, aliases: ['Manage Templates', 'Templates', 'New from template'] },
        { label: 'Save as template…', run: a.saveTemplate, aliases: ['Save as Template', 'Edit Template'] },
        { label: 'Reload', run: a.reload, aliases: ['Reload', 'Revert'] },
        'separator',
        { label: 'Export…', run: a.exportDocument, aliases: ['Export', 'Export as PDF', 'Export as HTML'] },
        { label: 'Print…', shortcut: 'Ctrl+P', run: a.print },
        { label: 'Settings…', shortcut: 'Ctrl+,', run: a.settings, aliases: ['Options', 'Preferences'] },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: a.undo },
        { label: 'Redo', shortcut: 'Ctrl+Y', run: a.redo },
        'separator',
        { label: 'Delete selection', run: a.deleteSelection, aliases: ['Delete'] },
        { label: 'Bring to front', run: a.front, aliases: ['Bring to Front', 'Arrange'] },
        { label: 'Send to back', run: a.back, aliases: ['Send to Back'] },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Normal', run: a.normalView, checked: () => !has.sorter(), aliases: ['Normal view'] },
        { label: 'Slide sorter', run: a.sorterView, checked: has.sorter, aliases: ['Slide Sorter'] },
        { label: 'Master', run: a.masters, aliases: ['Master Slide', 'Slide Master', 'Master Elements', 'Change Slide Master', 'Delete Master'] },
        { label: 'Properties sidebar', run: a.toggleSidebar, aliases: ['Sidebar', 'Properties'] },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Text box', run: a.addText, aliases: ['Insert Text Box', 'Text'] },
        { label: 'Image…', run: a.addImage, aliases: ['Insert Image', 'Picture'] },
        { label: 'Shape', run: a.addShape, aliases: ['Insert Shape'] },
        { label: 'Table', run: a.addTable, aliases: ['Insert Table'] },
        { label: 'Chart…', run: a.addChart, aliases: ['Insert Chart', 'Chart', 'Graph'] },
        { label: 'Formula…', run: a.addFormula, aliases: ['Formula Object', 'Equation', 'Math'] },
        'separator',
        { label: 'Header and footer…', run: a.footer, aliases: ['Header and Footer', 'Slide Number', 'Footer', 'Date and time', 'Page number'] },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Design: colours and fonts…', run: a.design, aliases: ['Edit Style', 'Update Selected Style', 'New Style from Selection', 'Manage Styles', 'Styles', 'Theme'] },
        { label: 'Colour of the selection…', run: a.elementLook, aliases: ['Area', 'Line', 'Colour'] },
        { label: 'Table rows and columns…', run: a.editTable, aliases: ['Table Properties'] },
        { label: 'Add a font…', run: a.addFont, aliases: ['Embed Font'] },
      ],
    },
    {
      label: 'Slide',
      items: [
        { label: 'New slide', shortcut: 'Ctrl+M', run: a.addSlide, aliases: ['New Slide', 'Add slide'] },
        { label: 'Duplicate slide', run: a.duplicateSlide, aliases: ['Duplicate Slide'] },
        { label: 'Delete slide', run: a.deleteSlide, aliases: ['Delete Slide'] },
        'separator',
        { label: 'Layout…', run: a.chooseLayout, aliases: ['Layout', 'Slide Layout', 'Blank Slide', 'Title and Subtitle', 'One Box', 'Centered Text', 'Two Boxes', 'Three Boxes (1 Left, 2 Right)', 'Three Boxes (2 Left, 1 Right)', 'Two Boxes (1 over 1)', 'Three Boxes (2 on Top over 1)', 'Four Boxes', 'Six Boxes'] },
        { label: 'Masters…', run: a.masters, aliases: ['Change Slide Master', 'Master Slides'] },
        { label: 'Master objects', run: a.masterObjects, checked: has.masterObjects, aliases: ['Master Objects', 'Show master objects'] },
        { label: 'Slide properties…', run: a.slideSetup, aliases: ['Slide Properties', 'Background', 'Transition', 'Master Background'] },
        { label: 'Slide size…', run: a.slideSize, aliases: ['Slide Size', 'Page size'] },
        { label: 'Section starting here…', run: a.section, aliases: ['Section'] },
        'separator',
        { label: 'Hide slide', run: () => a.hideSlide(true), enabled: () => !has.hidden(), aliases: ['Hide Slide'] },
        { label: 'Show slide', run: () => a.hideSlide(false), enabled: has.hidden, aliases: ['Show Slide'] },
        'separator',
        { label: 'Next slide', shortcut: 'PageDown', run: () => a.stepSlide(1) },
        { label: 'Previous slide', shortcut: 'PageUp', run: () => a.stepSlide(-1) },
      ],
    },
    {
      label: 'Slide Show',
      items: [
        { label: 'From the first slide', shortcut: 'F5', run: () => a.present(0), aliases: ['Start from First Slide', 'Present'] },
        { label: 'From this slide', shortcut: 'Shift+F5', run: () => a.present(null), aliases: ['Start from Current Slide'] },
        { label: 'Presenter view', run: a.presenter, aliases: ['Presenter Console', 'Presenter view'] },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'About GRT Slides', run: a.about, aliases: ['About', 'About %PRODUCTNAME'] },
        { label: 'Licences', run: a.licences, aliases: ['License Information', 'Licenses'] },
      ],
    },
  ];
}
