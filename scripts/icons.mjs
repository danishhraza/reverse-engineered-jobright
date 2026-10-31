// Draws the extension icon (a green pixel crab holding a resume) from a
// 16x16 grid and writes it as SVG + the PNG sizes Chrome wants. No
// dependencies: PNGs are encoded by hand with node:zlib.
// Run: node scripts/icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const GRID = [
  '................',
  '..GGGGGGGGGGGG..',
  '..GGGGGGGGGGGG..',
  '..GGKGGGGGGKGG..',
  '..GGKGGGGGGKGG..',
  'GGGGGGGGGGGGGGGG',
  'GGGGOOOOOOOOGGGG',
  '..GDOWWWWWWODG..',
  '..GDOWLLLLWODG..',
  '..GGOWWWWWWOGG..',
  '..GGOWLLLLLOGG..',
  '..D.OWWWWWWO.D..',
  '..D.OWLLLWWO.D..',
  '....OWWWWWWO....',
  '....OOOOOOOO....',
  '................',
];

const COLORS = {
  G: '#22c55e', // body
  D: '#15803d', // claws, legs
  K: '#052e16', // eyes
  O: '#14532d', // page outline
  W: '#ffffff', // page
  L: '#94a3b8', // text lines
};

const N = GRID.length;
const out = 'static/icons';
mkdirSync(out, { recursive: true });

// ---------- SVG ----------
const rects = [];
GRID.forEach((row, y) =>
  [...row].forEach((c, x) => {
    if (COLORS[c]) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[c]}"/>`);
  }),
);
writeFileSync(
  `${out}/icon.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">\n${rects.join('\n')}\n</svg>\n`,
);

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const scale = size / N;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const hex = COLORS[GRID[Math.floor(y / scale)][Math.floor(x / scale)]];
      const i = y * (size * 4 + 1) + 1 + x * 4;
      if (hex) {
        raw[i] = parseInt(hex.slice(1, 3), 16);
        raw[i + 1] = parseInt(hex.slice(3, 5), 16);
        raw[i + 2] = parseInt(hex.slice(5, 7), 16);
        raw[i + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(`${out}/icon${size}.png`, png(size));
console.log(`Wrote ${out}/icon.svg and icon16/32/48/128.png`);
