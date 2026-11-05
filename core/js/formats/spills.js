/** Formulas that fill a block of cells: what the files keep of them, and how Grid hands them over. */

/** Empties the cells a block formula covers, so the formula fills them again; the size mark goes too. */
export function clearSpilled(cells) {
  for (const [at, cell] of Object.entries(cells)) {
    if (!cell.a) continue;
    const [row, col] = at.split(',').map(Number);
    const [rows, cols] = cell.a;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (r === 0 && c === 0) continue;
        const covered = cells[`${row + r},${col + c}`];
        if (!covered || covered.f) continue;
        delete covered.v;
        if (Object.keys(covered).length === 0) delete cells[`${row + r},${col + c}`];
      }
    }
    delete cell.a;
  }
  return cells;
}
