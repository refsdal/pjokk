// A minimal RGB PNG encoder and the geometry of the Pjokk mark.
//
// Extracted from apps/landing/scripts/gen-og.mjs when the PWA icons needed
// the same two things (Phase: PWA install). Hand-rolled rather than pulled
// from an image library on purpose, and the reasoning is unchanged from the
// original: the mark is two circles, a circle-subtraction and a rounded
// square, so the whole job is a distance test per pixel plus a deflate call.
// That is cheaper than carrying a rasterizer as a build dependency, and it
// stays reproducible — the same input always writes the same bytes.

import { deflateSync } from "node:zlib";

// --- geometry --------------------------------------------------------------

export const inCircle = (x, y, c) =>
  (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r * c.r;

/**
 * Endpoint-to-centre conversion for an SVG elliptical arc with rx == ry and
 * no x-axis rotation (SVG 1.1 appendix F.6.5).
 *
 * The centres used to be hardcoded constants with a note to "re-derive them
 * rather than nudging by eye" if icon.svg changed. Deriving them here from
 * the path's own numbers removes that footgun: the literals below are copied
 * straight out of the `d` attribute, and this reproduces the old constants
 * exactly (A = 254.677, 245.719).
 */
export function arcCentre(x1, y1, x2, y2, r, largeArc, sweep) {
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const den = dx2 * dx2 + dy2 * dy2;
  const num = r * r - den;
  const factor = Math.sqrt(Math.max(0, num / den));
  const sign = largeArc !== sweep ? 1 : -1;
  return {
    x: sign * factor * dy2 + (x1 + x2) / 2,
    y: sign * factor * -dx2 + (y1 + y2) / 2,
    r,
  };
}

/**
 * The crescent: inside the first arc's circle and outside the second's.
 * `path` mirrors an icon SVG's `d` — a move, an arc, a relative arc back.
 */
export function crescent(path) {
  const { x, y, arc1, arc2 } = path;
  const end = { x: x + arc1.dx, y: y + arc1.dy };
  return {
    outer: arcCentre(x, y, end.x, end.y, arc1.r, arc1.largeArc, arc1.sweep),
    inner: arcCentre(
      end.x,
      end.y,
      end.x + arc2.dx,
      end.y + arc2.dy,
      arc2.r,
      arc2.largeArc,
      arc2.sweep,
    ),
  };
}

/** Rounded square spanning 0..size, with corner radius `radius`. */
export function inRoundedSquare(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  if (dx <= 0 || dy <= 0) {
    return Math.abs(x - half) <= half && Math.abs(y - half) <= half;
  }
  return dx * dx + dy * dy <= radius * radius;
}

// --- encoder ---------------------------------------------------------------

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

/**
 * Renders `sample(x, y) -> [r, g, b]` into a PNG buffer.
 *
 * `supersample` averages an NxN grid per pixel; the only curves here are
 * circle edges, so 4x4 is enough to keep them smooth.
 */
export function encodePng(width, height, sample, { supersample = 4 } = {}) {
  // One filter byte (0 = None) per row, then RGB triples. A flat background
  // makes long identical runs, which deflate handles very well.
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  const n = supersample * supersample;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const c = sample(
            x + (sx + 0.5) / supersample,
            y + (sy + 0.5) / supersample,
          );
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      raw[p++] = Math.round(r / n);
      raw[p++] = Math.round(g / n);
      raw[p++] = Math.round(b / n);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
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
