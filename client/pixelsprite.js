// Tiny standalone helper: render a Hero Builder hero's 8x8 pixel art (see shared/hero-builder.js
// PALETTE + validateHero's `pixels` rule) onto a canvas. Split out of client/heroes.js into its
// own module specifically so client/game.js can import just this (no builder UI, no /api/heroes
// calls) once the sim/lobby integration lands — see README.md "Hero Builder" > "Integration
// contract" part (d).
const cache = new Map();

/** Draw `pixels` (8 strings of 8 chars, each '.' or a palette index '0'-'7') onto a fresh canvas
 *  at `scale` px per source pixel (default 4, i.e. a 32x32 canvas), using `palette` (default
 *  shared/hero-builder.js PALETTE) for the index-to-colour lookup. Cached by content so repeated
 *  calls for the same hero+scale are cheap. Returns the canvas (or null if `pixels` is malformed —
 *  callers already run validateHero server-side, so this is a defensive fallback, not primary
 *  validation). */
export function spriteFromPixels(pixels, palette, scale = 4) {
  if (!Array.isArray(pixels) || pixels.length !== 8) return null;
  const key = pixels.join('|') + '@' + scale + '|' + (palette || []).join(',');
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = 8 * scale; c.height = 8 * scale;
  const ctx = c.getContext('2d');
  for (let y = 0; y < 8; y++) {
    const row = String(pixels[y] || '');
    for (let x = 0; x < 8; x++) {
      const ch = row[x];
      if (!ch || ch === '.') continue;
      const idx = ch.charCodeAt(0) - 48; // '0'-'7' -> 0-7
      const col = palette?.[idx];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  cache.set(key, c);
  return c;
}

/** Clear the sprite cache — useful after editing a hero's pixels in place so a stale canvas
 *  under the same content key (rare, but possible if a palette color itself was edited) isn't
 *  returned. Not needed in the common case since content changes naturally change the cache key. */
export function clearSpriteCache() { cache.clear(); }
