// Pure canvas-fit math for the mobile-responsive game screen (#31, reworked by #42). Deliberately
// dependency-free (no DOM, no browser globals) so it runs under plain Node for test/layout.test.js;
// client/game.js is the only caller that touches the real viewport/canvas, and it does so by
// measuring the actual rendered HUD/log/touch-controls heights and feeding them in here rather than
// duplicating this math inline. Before #42, `vw`/`vh` were `.stage`'s own measured box, already
// shrunk by CSS flexbox to exclude the nav bar, page padding and the log/chat/help row below the
// stage — so this module never needed to know about `#log`. #42 replaced that flexbox column with
// a CSS grid spanning the whole game screen (HUD strip / canvas / log strip / controls band, see
// client/style.css's "body.gc-playing" block) so the log strip is now a sibling grid track rather
// than something an ancestor's flexbox silently excluded — hence `logH`, and the `controlsAvailH`
// this now returns (the space left over below the canvas once HUD+log are accounted for, which is
// exactly what the controls band actually gets from the grid's `1fr` track — client/game.js sizes
// the on-screen d-pad/fire/potion buttons from that measured leftover rather than from `vw`, so
// they can never overflow it, see input.js's buildTouchUI() consumers of --dpad-cell/--fire-size).

/**
 * Fit a fixed-aspect game canvas into `vw`x`vh` minus the HUD strip (`hudH`, stacked above the
 * canvas) and a touch-controls band (`controlsH`, stacked below — pass 0 when the controls instead
 * overlay the canvas edges, as they do in the landscape-phone layout). Snaps down to an exact
 * integer multiple of the logical resolution (crisp, no soft scaling) whenever one fits, accepting
 * the letterboxing that costs (e.g. a raw fit of 1.4x becomes 1x); only below 1x, where no integer
 * scale exists, does it fall back to the fractional fit. Both are drawn with `image-rendering:
 * pixelated` in CSS (see client/style.css), so the caller never needs to treat the two cases
 * differently beyond picking the backing-store resolution.
 *
 *  - vw/vh: the box available for [HUD + canvas + log + controls] combined (CSS px) — the whole
 *    game screen (client/game.js passes `#session`'s own measured box)
 *  - hudH/logH: space already consumed by the HUD strip / log strip (CSS px, >= 0)
 *  - controlsH: space to *reserve* for the controls band when fitting the canvas (CSS px, >= 0;
 *    pass 0 when the controls instead overlay the canvas edges, as they do in the landscape-phone
 *    layout — see client/game.js's `overlayControls`). This is an estimate fed in by the caller
 *    (typically the controls band's own previously-rendered height) used only to decide how much
 *    room the *canvas* gets; `controlsAvailH` below reports what's actually left afterward, which
 *    is what the controls band itself should be sized from.
 *  - levelW/levelH: the game's fixed logical resolution (VIEW_W/VIEW_H in client/game.js)
 *  - dpr: devicePixelRatio, for a crisp canvas backing store
 *
 * Returns `{ width, height, scale, backingWidth, backingHeight, orientation, controlsAvailH }`.
 * width/height are the canvas element's on-screen (CSS px) size; backingWidth/backingHeight are the
 * drawing-buffer size (canvas.width/height) to set for a sharp image at that CSS size and dpr.
 * controlsAvailH is `vh - hudH - logH - height` — the true leftover height below the fitted canvas
 * once the HUD and log strips are accounted for, which is what the controls band's CSS grid track
 * actually resolves to (a `1fr` row eats all of it regardless of `controlsH`'s estimate) — client/
 * game.js sizes the d-pad cells and fire/potion buttons from this, never from `vw`, so a bad
 * `controlsH` estimate only affects the canvas's own fit, never causes the controls to overflow
 * the space the grid actually gave them. The caller is responsible for positioning (centering
 * horizontally, pinning to the top of the region left after `hudH` so any leftover space collects
 * where the controls band actually is, at the bottom).
 */
export function computeCanvasLayout({ vw, vh, hudH = 0, logH = 0, controlsH = 0, levelW, levelH, dpr = 1 } = {}) {
  vw = Math.max(1, Number(vw) || 0);
  vh = Math.max(1, Number(vh) || 0);
  hudH = Math.max(0, Number(hudH) || 0);
  logH = Math.max(0, Number(logH) || 0);
  controlsH = Math.max(0, Number(controlsH) || 0);
  levelW = Math.max(1, Number(levelW) || 1);
  levelH = Math.max(1, Number(levelH) || 1);
  dpr = Math.max(1, Number(dpr) || 1);

  const orientation = vw >= vh ? 'landscape' : 'portrait';
  const availW = vw;
  const availH = Math.max(1, vh - hudH - logH - controlsH);

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

  // Floor, never round: vw/vh come from getBoundingClientRect() and can be fractional, and a
  // rounded-up box would overflow the available space by a pixel and clip in tight layouts.
  width = Math.max(1, Math.floor(levelW * scale));
  height = Math.max(1, Math.floor(levelH * scale));

  return {
    orientation,
    width, height,
    scale,
    backingWidth: Math.max(1, Math.round(width * dpr)),
    backingHeight: Math.max(1, Math.round(height * dpr)),
    // Never negative even if hudH/logH/height somehow sum past vh (e.g. a stale controlsH estimate
    // on the very first layout pass, before anything has actually been measured).
    controlsAvailH: Math.max(0, vh - hudH - logH - height),
  };
}
