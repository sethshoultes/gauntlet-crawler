// Pure canvas-fit math for the mobile-responsive game screen (#31). Deliberately dependency-free
// (no DOM, no browser globals) so it runs under plain Node for test/layout.test.js; client/game.js
// is the only caller that touches the real viewport/canvas, and it does so by measuring the actual
// rendered HUD/touch-controls heights and feeding them in here rather than duplicating this math
// inline. See client/game.js's layoutGame() for how `vw`/`vh` end up being `.stage`'s own measured
// box (which CSS flexbox has already shrunk to exclude the nav bar, page padding, chat log/bar,
// etc.) rather than the raw window size — this module only ever needs to know about the HUD strip
// and the touch-controls band, the two things specific to the game screen itself.

/**
 * Fit a fixed-aspect game canvas into `vw`x`vh` minus the HUD strip (`hudH`, stacked above the
 * canvas) and a touch-controls band (`controlsH`, stacked below — pass 0 when the controls instead
 * overlay the canvas edges, as they do in the landscape-phone layout). Prefers an exact integer
 * multiple of the logical resolution (crisp, no soft scaling) when one fits without shrinking the
 * result versus a plain fractional fit; otherwise falls back to the fractional fit; both are drawn
 * with `image-rendering: pixelated` in CSS (see client/style.css), so the caller never needs to
 * treat the two cases differently beyond picking the backing-store resolution.
 *
 *  - vw/vh: the box available for [HUD + canvas + controls] combined (CSS px)
 *  - hudH/controlsH: space already consumed by the HUD strip / touch-controls band (CSS px, >= 0)
 *  - levelW/levelH: the game's fixed logical resolution (VIEW_W/VIEW_H in client/game.js)
 *  - dpr: devicePixelRatio, for a crisp canvas backing store
 *
 * Returns `{ width, height, scale, backingWidth, backingHeight, orientation }`. width/height are
 * the canvas element's on-screen (CSS px) size; backingWidth/backingHeight are the drawing-buffer
 * size (canvas.width/height) to set for a sharp image at that CSS size and dpr. The caller is
 * responsible for positioning (centering horizontally, pinning to the top of the region left after
 * `hudH` so any leftover space collects where the controls band actually is, at the bottom).
 */
export function computeCanvasLayout({ vw, vh, hudH = 0, controlsH = 0, levelW, levelH, dpr = 1 } = {}) {
  vw = Math.max(1, Number(vw) || 0);
  vh = Math.max(1, Number(vh) || 0);
  hudH = Math.max(0, Number(hudH) || 0);
  controlsH = Math.max(0, Number(controlsH) || 0);
  levelW = Math.max(1, Number(levelW) || 1);
  levelH = Math.max(1, Number(levelH) || 1);
  dpr = Math.max(1, Number(dpr) || 1);

  const orientation = vw >= vh ? 'landscape' : 'portrait';
  const availW = vw;
  const availH = Math.max(1, vh - hudH - controlsH);

  const aspect = levelW / levelH;
  let width = availW;
  let height = width / aspect;
  if (height > availH) { height = availH; width = height * aspect; }

  const rawScale = width / levelW;
  const intScale = Math.floor(rawScale);
  let scale = rawScale;
  if (intScale >= 1) {
    const iw = intScale * levelW, ih = intScale * levelH;
    if (iw <= availW && ih <= availH) scale = intScale;
  }

  width = Math.max(1, Math.round(levelW * scale));
  height = Math.max(1, Math.round(levelH * scale));

  return {
    orientation,
    width, height,
    scale,
    backingWidth: Math.max(1, Math.round(width * dpr)),
    backingHeight: Math.max(1, Math.round(height * dpr)),
  };
}
