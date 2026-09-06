#!/usr/bin/env node
// Generates the installable-PWA home-screen icons (#33): client/icons/icon-192.png,
// icon-512.png, icon-512-maskable.png and apple-touch-icon.png.
//
// Pure Node, no native deps and no image-manipulation npm packages: a tiny RGBA raster is drawn
// by hand (chunky pixel-art scaling, nearest-neighbour) and encoded straight to PNG bytes using
// only node:zlib's deflateSync/crc32. The art is a scaled-up copy of the 8x8 `hero` sprite pattern
// from client/sprites.js, tinted with the warrior class colour (shared/constants.js) on the
// game's dark background (client/style.css --bg) — the same look the existing favicon
// (`<link rel="icon">` inline SVG on every page) already uses, just bigger and rasterised.
//
// client/sprites.js itself can't be imported here: its sprite() cache helper touches `document`
// (a real <canvas>) at call time, so it isn't Node-safe. The pattern below is kept as a small,
// clearly-labelled literal copy instead.
//
// Usage:
//   node tools/generate-icons.mjs            # (re)writes client/icons/*.png in place
// test/pwa.test.js re-renders the same icons into a temp dir and byte-compares them against the
// committed files, so the two can never silently drift apart.

import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSES } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ICONS_DIR = path.join(ROOT, 'client', 'icons');

const BG = '#0b0b12'; // client/style.css --bg
const SKIN = '#e8c39e';
const OUTLINE = '#000000';
const BODY = CLASSES.warrior.color; // '#e03c31' — same red the arcade favicon already tints with

// Mirrors client/sprites.js's `hero` SPR pattern (8 rows of 8 chars; '.' = transparent/background).
const HERO_ROWS = [
  '..ssss..',
  '..sksk..',
  '..ssss..',
  '.rrrrrr.',
  'srrrrrrs',
  '.rrrrrr.',
  '..rr.rr.',
  '..kk.kk.',
];
const PAL = { '.': null, s: SKIN, k: OUTLINE, r: BODY };

/** The icons this script produces, plus how much background margin to leave on every side.
 * Maskable icons must keep their art inside a centred "safe zone" circle 80% of the icon's
 * diameter (i.e. content within ~40% of the centre) since the OS can crop to any shape outside
 * it — a bigger margin than the plain icons need. */
export const ICON_SPECS = [
  { file: 'icon-192.png', size: 192, marginRatio: 0.08 },
  { file: 'icon-512.png', size: 512, marginRatio: 0.08 },
  { file: 'icon-512-maskable.png', size: 512, marginRatio: 0.18, purpose: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, marginRatio: 0.08 },
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Minimal top-left-origin RGBA raster: one Uint8ClampedArray, 4 bytes/pixel, no alpha blending
 * (every fill is fully opaque, which is all these flat pixel-art icons need). */
function makeCanvas(size, bgHex) {
  const px = new Uint8ClampedArray(size * size * 4);
  const [r, g, b] = hexToRgb(bgHex);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255;
  }
  return { size, px };
}

function fillRect(canvas, x, y, w, h, hex) {
  const [r, g, b] = hexToRgb(hex);
  for (let yy = Math.max(0, y); yy < Math.min(canvas.size, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(canvas.size, x + w); xx++) {
      const i = (yy * canvas.size + xx) * 4;
      canvas.px[i] = r; canvas.px[i + 1] = g; canvas.px[i + 2] = b; canvas.px[i + 3] = 255;
    }
  }
}

/** Draws HERO_ROWS scaled up (nearest-neighbour, integer scale) and centred, leaving
 * `marginRatio` of the canvas as background border on every side. */
function drawHero(canvas, marginRatio) {
  const margin = Math.round(canvas.size * marginRatio);
  const artSize = canvas.size - margin * 2;
  const scale = Math.max(1, Math.floor(artSize / 8));
  const drawn = scale * 8;
  const offset = Math.round((canvas.size - drawn) / 2);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const hex = PAL[HERO_ROWS[y][x]];
      if (!hex) continue;
      fillRect(canvas, offset + x * scale, offset + y * scale, scale, scale, hex);
    }
  }
}

// ---------- pure-Node PNG encoder (8-bit RGBA, filter type 0, single IDAT) ----------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG({ size, px }) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type 6 = RGBA
  ihdr[10] = 0; // compression method (only valid value)
  ihdr[11] = 0; // filter method (only valid value)
  ihdr[12] = 0; // interlace: none

  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // per-scanline filter type: None
    for (let i = 0; i < stride; i++) raw[rowStart + 1 + i] = px[y * stride + i];
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

export function renderIconBuffer(size, marginRatio) {
  const canvas = makeCanvas(size, BG);
  drawHero(canvas, marginRatio);
  return encodePNG(canvas);
}

/** Renders every spec in ICON_SPECS into `outDir` (created if needed) and returns the written
 * file paths. Exported so test/pwa.test.js can regenerate into a scratch directory and
 * byte-compare against the committed client/icons/*.png. */
export function generateAll(outDir = ICONS_DIR) {
  mkdirSync(outDir, { recursive: true });
  return ICON_SPECS.map((spec) => {
    const file = path.join(outDir, spec.file);
    writeFileSync(file, renderIconBuffer(spec.size, spec.marginRatio));
    return file;
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const file of generateAll()) console.log(`wrote ${path.relative(ROOT, file)}`);
}
