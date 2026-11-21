/** Slides' own fill and outline as the drawing core's line and area, for the writers of every format. */

/**
 * A drawing element with a line and an area of its own: its own when it has them, else Slides' fill and outline, else the theme's.
 * @param {Object} element
 * @param {{accent?: string, text?: string}} theme
 */
export function slidesLook(element, theme = {}) {
  const fill = element.fill ?? theme.accent ?? '#1f6feb';
  const lined = element.kind === 'path' || element.kind === 'connector';
  return {
    ...element,
    line: element.line ?? (element.stroke ? { color: element.stroke, width: element.strokeWidth ?? 2 } : lined ? { color: theme.text ?? '#333333', width: 4 } : { style: 'none' }),
    fillLook: element.fillLook ?? (fill === 'none' ? { type: 'none' } : { type: 'solid', color: fill }),
    ...(element.kind === 'group' ? { children: (element.children ?? []).map((c) => slidesLook(c, theme)) } : {}),
  };
}

/** Whether a slide element is one the drawing core writes: a shape, a path, a connector, a group, or a picture with a drawing's settings. */
export const isDrawing = (e) => ['shape', 'path', 'connector', 'group', 'scene3d'].includes(e.kind)
  || (e.kind === 'image' && Boolean(e.crop || e.adjust || e.flipH || e.flipV || e.line || e.name || e.description));
