// Chunky 5x7 bitmap font for arcade-style pixel text. No external font files, no DOM
// dependency at import time — everything here only ever calls methods on the `ctx` (a
// CanvasRenderingContext2D, or a stub in tests) that is handed to it.
//
// Coverage: A-Z, 0-9, space and basic punctuation ( . , ! ? : ' - ). Unknown characters
// render as a blank space-width cell so a stray character never throws.

export const GLYPH_W = 5;
export const GLYPH_H = 7;

// Each glyph is 7 rows of a 5-bit string ('1' = pixel on). Authored by hand for a blocky
// 1985-arcade look rather than lifted from any real typeface.
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00000', '01100'],
  ',': ['00000', '00000', '00000', '00000', '00000', '01100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '%': ['10001', '00010', '00100', '01000', '10000', '10001', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};
const BLANK = FONT[' '];

function glyphFor(ch) {
  return FONT[ch] || FONT[ch.toUpperCase?.()] || BLANK;
}

/** Width in pixels (unscaled) of `text` set in this font, including inter-glyph spacing. */
export function measureText(text, scale = 1, letterSpacing = 1) {
  const str = String(text);
  if (!str.length) return 0;
  return str.length * (GLYPH_W + letterSpacing) * scale - letterSpacing * scale;
}

/**
 * Draw pixel text with ctx.fillRect calls only — no ctx.font / fillText, so it looks
 * identical (chunky, aliased) on every browser and works against a plain object stub.
 * opts: { scale=2, color='#fff', align='left'|'center'|'right', shadow=false|true|color,
 *         letterSpacing=1, lineHeight=2 (extra rows between wrapped lines) }
 */
export function drawText(ctx, text, x, y, opts = {}) {
  const {
    scale = 2, color = '#ffffff', align = 'left', shadow = false,
    letterSpacing = 1, lineHeight = 2, alpha = 1,
  } = opts;
  const lines = String(text).split('\n');
  const rowH = (GLYPH_H + lineHeight) * scale;
  const prevAlpha = ctx.globalAlpha;
  if (alpha !== 1 && typeof prevAlpha === 'number') ctx.globalAlpha = prevAlpha * alpha;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const w = measureText(line, scale, letterSpacing);
    let px = x;
    if (align === 'center') px = x - w / 2;
    else if (align === 'right') px = x - w;
    const py = y + li * rowH;
    if (shadow) {
      const sc = shadow === true ? 'rgba(0,0,0,.85)' : shadow;
      drawLine(ctx, line, px + scale, py + scale, scale, letterSpacing, sc);
    }
    drawLine(ctx, line, px, py, scale, letterSpacing, color);
  }
  if (alpha !== 1 && typeof prevAlpha === 'number') ctx.globalAlpha = prevAlpha;
  return { width: lines.reduce((m, l) => Math.max(m, measureText(l, scale, letterSpacing)), 0), height: lines.length * rowH };
}

function drawLine(ctx, line, x, y, scale, letterSpacing, color) {
  ctx.fillStyle = color;
  let cx = x;
  for (let i = 0; i < line.length; i++) {
    const rows = glyphFor(line[i]);
    for (let ry = 0; ry < GLYPH_H; ry++) {
      const row = rows[ry];
      for (let rx = 0; rx < GLYPH_W; rx++) {
        if (row[rx] === '1') ctx.fillRect(cx + rx * scale, y + ry * scale, scale, scale);
      }
    }
    cx += (GLYPH_W + letterSpacing) * scale;
  }
}

/** Greedy word-wrap: splits `text` into lines no wider than maxWidth px at this scale. */
export function wrapText(text, maxWidth, scale = 2, letterSpacing = 1) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (measureText(trial, scale, letterSpacing) > maxWidth && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
