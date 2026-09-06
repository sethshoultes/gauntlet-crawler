// Pure grid-line interpolation for drag-to-paint editors (Hero Builder's pixel grid, Level
// Builder's tile grid — see client/heroes.js and client/editor.js). A pointerdown/pointermove
// listener alone paints only the exact cells the browser happened to report a move at; on a fast
// mouse swipe or (especially) a touch drag, consecutive events can land several cells apart and
// leave visible gaps in the stroke. paintPath() walks every integer cell on the straight line
// between two grid coordinates (Bresenham's algorithm) so the caller can paint the whole path.
// No DOM, no canvas — safe to unit-test directly and to import from either editor.
export function paintPath(from, to) {
  let [x, y] = from;
  const [x1, y1] = to;
  const points = [];
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    points.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return points;
}
