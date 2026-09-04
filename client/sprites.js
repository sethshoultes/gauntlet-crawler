// 8x8 pixel sprites in the spirit of 1985 arcade hardware, drawn procedurally so no assets are needed.
// Each sprite is 8 rows of 8 characters; the palette maps characters to colours ('.' = transparent).
export const TILE = 16; // world tile in source pixels (8x8 art drawn at 2x)

const PAL = {
  '.': null,
  'k': '#000000', 'w': '#f4f4f4', 'g': '#9a9aa8', 'd': '#3a3a4c', 'b': '#2b2b3d', 'B': '#4a4a6a', 'f': '#14141f', 'F': '#1c1c2a',
  'r': '#e03c31', 'R': '#8f1f18', 'o': '#ff8c1a', 'y': '#f2c400', 'Y': '#fff28a', 'l': '#3b7dff', 'L': '#1f4fb0', 'e': '#2ecc40', 'E': '#187f27',
  'p': '#a05cff', 'P': '#5a2d99', 'n': '#c97b3a', 'N': '#7a4520', 's': '#e8c39e', 'c': '#5cd6ff', 't': '#b0b0c0',
};

const SPR = {
  wall: [
    'BBBBBBBB',
    'BbbbBbbb',
    'BBBBBBBB',
    'bbBbbbBb',
    'BBBBBBBB',
    'BbbbBbbb',
    'BBBBBBBB',
    'bbBbbbBb',
  ],
  floor: [
    'ffffffff',
    'fFffffff',
    'ffffffFf',
    'ffffffff',
    'fffFffff',
    'ffffffff',
    'fFffffFf',
    'ffffffff',
  ],
  trap: [ // secret wall: like wall but with a hairline crack
    'BBBBBBBB',
    'BbbbBbbb',
    'BBBBBBfB',
    'bbBbbfBb',
    'BBBBfBBB',
    'BbbfBbbb',
    'BBfBBBBB',
    'bbBbbbBb',
  ],
  door: [
    'yyyyyyyy',
    'y.y..y.y',
    'y.y..y.y',
    'yyyyyyyy',
    'y.y..y.y',
    'y.y..y.y',
    'yyyyyyyy',
    'y.y..y.y',
  ],
  key: [
    '........',
    '.yyy....',
    'y...y...',
    'y...yyyy',
    'y...y.y.',
    '.yyy..y.',
    '........',
    '........',
  ],
  food: [
    '........',
    '...nnn..',
    '..nnnnn.',
    '.nnnnnnn',
    '.nNnnnNn',
    '..nnnnn.',
    '...ww...',
    '..w..w..',
  ],
  potion: [
    '...tt...',
    '...cc...',
    '...cc...',
    '..cccc..',
    '.cccccc.',
    '.clcccc.',
    '.cccccc.',
    '..cccc..',
  ],
  treasure: [
    '........',
    '.NNNNNN.',
    'NyyyyyyN',
    'NyNNNNyN',
    'NNNyyNNN',
    'NyNNNNyN',
    'NyyyyyyN',
    '.NNNNNN.',
  ],
  exit: [
    'gggggggg',
    'gdddddgg',
    'gdkkkkdg',
    'gdkkkkdg',
    'gdkkkkdg',
    'gdkkkkdg',
    'gddddddg',
    'gggggggg',
  ],
  gen1: [ // ghost/grunt/demon generators share a bone pile shape, tinted by type
    '........',
    '........',
    '..w..w..',
    '.wwwwww.',
    '.wkwwkw.',
    '.wwwwww.',
    '.w.ww.w.',
    'wwwwwwww',
  ],
  gen2: [
    '........',
    '..w..w..',
    '.wwwwww.',
    '.wkwwkw.',
    '.wwwwww.',
    'w.w.ww.w',
    'wwwwwwww',
    'wwwwwwww',
  ],
  gen3: [
    '..w..w..',
    '.wwwwww.',
    '.wkwwkw.',
    '.wwwwww.',
    'w.wwww.w',
    'wwwwwwww',
    'wwwwwwww',
    'wwwwwwww',
  ],
  ghost: [
    '..wwww..',
    '.wwwwww.',
    '.wkwwkw.',
    '.wwwwww.',
    '.wwwwww.',
    '.wwwwww.',
    '.wwwwww.',
    '.w.ww.w.',
  ],
  grunt: [
    '..nnnn..',
    '.nnnnnn.',
    '.nknnkn.',
    '.nnnnnn.',
    'NNnnnnNN',
    'N.nnnn.N',
    '..NNNN..',
    '..N..N..',
  ],
  demon: [
    'r......r',
    '.r....r.',
    '.rrrrrr.',
    '.rYrrYr.',
    '.rrrrrr.',
    'rrRrrRrr',
    '..rrrr..',
    '..r..r..',
  ],
  death: [
    '..kkkk..',
    '.kwwwwk.',
    '.kwkwkwk',
    '.kwwwwk.',
    '..kwwk..',
    '.kkkkkk.',
    '.kkkkkk.',
    '.k.kk.k.',
  ],
  hero: [ // body tinted per class (colour 'r' replaced), skin 's'
    '..ssss..',
    '..sksk..',
    '..ssss..',
    '.rrrrrr.',
    'srrrrrrs',
    '.rrrrrr.',
    '..rr.rr.',
    '..kk.kk.',
  ],
  axe: [
    '........',
    '..tt....',
    '.ttt....',
    '.tttn...',
    '..ttnn..',
    '.....nn.',
    '......n.',
    '........',
  ],
  sword: [
    '........',
    '......t.',
    '.....tt.',
    '....tt..',
    '...tt...',
    '..yy....',
    '.yn.....',
    '........',
  ],
  fireball: [
    '........',
    '...oo...',
    '..oyyo..',
    '.oyYYyo.',
    '.oyYYyo.',
    '..oyyo..',
    '...oo...',
    '........',
  ],
  arrow: [
    '........',
    '........',
    '.......e',
    '.nnnnnee',
    '.....eee',
    '.......e',
    '........',
    '........',
  ],
  dfire: [
    '........',
    '...rr...',
    '..roor..',
    '.royyor.',
    '.royyor.',
    '..roor..',
    '...rr...',
    '........',
  ],
};

const cache = new Map();
export function sprite(name, tint = null, scale = 2) {
  const key = `${name}|${tint || ''}|${scale}`;
  if (cache.has(key)) return cache.get(key);
  const rows = SPR[name];
  const c = document.createElement('canvas');
  c.width = 8 * scale; c.height = 8 * scale;
  const ctx = c.getContext('2d');
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const ch = rows[y][x];
    let col = PAL[ch];
    if (tint && (ch === 'r' || ch === 'w') && name !== 'ghost' && name !== 'death' && name !== 'demon') col = ch === 'r' ? tint : tint;
    if (!col) continue;
    ctx.fillStyle = col;
    ctx.fillRect(x * scale, y * scale, scale, scale);
  }
  cache.set(key, c);
  return c;
}

export const GEN_TINT = { g: '#c97b3a', h: '#f4f4f4', m: '#e03c31' };
export const TILE_SPRITE = { '#': 'wall', '.': 'floor', 'D': 'door', 'K': 'key', 'F': 'food', 'P': 'potion', 'T': 'treasure', 'E': 'exit', 'S': 'floor', 'W': 'trap' };
export const SHOT_SPRITE = { w: 'axe', v: 'sword', z: 'fireball', e: 'arrow', d: 'dfire' };
