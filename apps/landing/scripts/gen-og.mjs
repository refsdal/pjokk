// Renders apps/landing/public/og.png — the 1200x630 link-preview card for
// pjokk.no. The landing site is its own deploy with its own asset directory
// (apps/frontend/public/ keeps the SPA's copy), so this writes here, not
// there.
//
//   node apps/landing/scripts/gen-og.mjs
//
// Hand-rolled rather than pulled from an image library on purpose: the card
// is the app icon on the brand background, which is two circles and a
// circle-subtraction, so the whole job is a distance test per pixel and a
// minimal PNG writer. That is cheaper than carrying a rasterizer as a
// dependency for one static file, and it stays reproducible.
//
// There is no wordmark because rendering text would need a font dependency;
// every platform that shows this card renders og:title and og:description as
// text beside it anyway.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const W = 1200;
const H = 630;

// Palette. The tile and mark are straight from public/icon.svg; the card
// behind them is --accent-soft, so the icon reads as an app icon rather than
// as a shape floating on nothing.
const CARD = [0xf7, 0xe9, 0xe2];
const TILE = [0xfa, 0xf9, 0xf7];
const MOON = [0xe8, 0x8d, 0x67];
const DOT = [0x8b, 0x7b, 0xd8];

// The icon's crescent is `M330 116 a150…1 0 66 180 a118…0 1 -66 -180 z`:
// the region inside a 150-radius circle and outside a 118-radius one. These
// centres come from the SVG endpoint-to-centre arc conversion; if icon.svg
// ever changes, re-derive them rather than nudging by eye.
const A = { x: 254.677, y: 245.719, r: 150 };
const B = { x: 427.607, y: 182.311, r: 118 };
const STAR = { x: 352, y: 152, r: 18 };

// icon.svg draws into a 512 box with a rounded-square backdrop (rx 115).
// Place that whole box 340px across, centred, and do every test in the
// icon's own coordinates so this stays a faithful reproduction.
const BOX = 340;
const ICON_SIZE = 512;
const ICON_RADIUS = 115;

const inCircle = (x, y, c) => (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r * c.r;

/** Rounded square spanning 0..512 in icon coordinates. */
function inTile(x, y) {
  const half = ICON_SIZE / 2;
  const dx = Math.abs(x - half) - (half - ICON_RADIUS);
  const dy = Math.abs(y - half) - (half - ICON_RADIUS);
  if (dx <= 0 || dy <= 0) {
    return Math.abs(x - half) <= half && Math.abs(y - half) <= half;
  }
  return dx * dx + dy * dy <= ICON_RADIUS * ICON_RADIUS;
}

/** Colour at one point, in canvas coordinates. */
function sample(px, py) {
  const scale = ICON_SIZE / BOX;
  const ix = ICON_SIZE / 2 + (px - W / 2) * scale;
  const iy = ICON_SIZE / 2 + (py - H / 2) * scale;
  if (!inTile(ix, iy)) return CARD;
  if (inCircle(ix, iy, STAR)) return DOT;
  if (inCircle(ix, iy, A) && !inCircle(ix, iy, B)) return MOON;
  return TILE;
}

// 4x4 supersampling: the only curves here are circle edges, and averaging 16
// samples is enough to keep them smooth at this size.
const SS = 4;

function render() {
  // One filter byte (0 = None) per row, then RGB triples. A flat background
  // makes long identical runs, which deflate handles very well.
  const raw = Buffer.alloc(H * (1 + W * 3));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      raw[p++] = Math.round(r / n);
      raw[p++] = Math.round(g / n);
      raw[p++] = Math.round(b / n);
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB, no alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
const buf = png(render());
writeFileSync(out, buf);
console.log(`og.png written: ${W}x${H}, ${(buf.length / 1024).toFixed(1)} kB`);
