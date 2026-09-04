// The Pjokk mark, in its own 512x512 coordinate space — the shared source of
// truth for every raster of it (the landing site's og.png and the PWA icons).
//
// The numbers below are copied verbatim out of the `d` attributes in
// apps/frontend/public/icon.svg and icon-maskable.svg. Nothing here is
// derived by hand: crescent() turns the arc endpoints into centres. If an
// SVG changes, change the literals to match and the rasters follow.

import { crescent, inCircle, inRoundedSquare } from "./png.mjs";

export const ICON_SIZE = 512;

// Palette, straight from the SVGs. CARD is --accent-soft, used only as the
// backdrop the og card floats the tile on.
export const CARD = [0xf7, 0xe9, 0xe2];
export const TILE = [0xfa, 0xf9, 0xf7];
export const MOON = [0xe8, 0x8d, 0x67];
export const DOT = [0x8b, 0x7b, 0xd8];

// icon.svg: rect rx=115, then
//   M330 116 a150 150 0 1 0 66 180 a118 118 0 0 1 -66 -180 z
//   circle cx=352 cy=152 r=18
export const STANDARD = {
  radius: 115,
  crescent: crescent({
    x: 330,
    y: 116,
    arc1: { dx: 66, dy: 180, r: 150, largeArc: 1, sweep: 0 },
    arc2: { dx: -66, dy: -180, r: 118, largeArc: 0, sweep: 1 },
  }),
  dot: { x: 352, y: 152, r: 18 },
};

// icon-maskable.svg: no rounding (the platform applies its own mask), and a
// smaller mark so everything stays inside the maskable safe zone.
//   M312 156 a112 112 0 1 0 49 134 a88 88 0 0 1 -49 -134 z
//   circle cx=328 cy=182 r=14
export const MASKABLE = {
  radius: 0,
  crescent: crescent({
    x: 312,
    y: 156,
    arc1: { dx: 49, dy: 134, r: 112, largeArc: 1, sweep: 0 },
    arc2: { dx: -49, dy: -134, r: 88, largeArc: 0, sweep: 1 },
  }),
  dot: { x: 328, y: 182, r: 14 },
};

/**
 * Colour at a point in icon coordinates, or `null` outside the tile so the
 * caller can decide what sits behind it (a card, or nothing).
 */
export function sampleMark(ix, iy, spec) {
  if (spec.radius > 0 && !inRoundedSquare(ix, iy, ICON_SIZE, spec.radius)) {
    return null;
  }
  if (spec.radius === 0) {
    const outside = ix < 0 || iy < 0 || ix > ICON_SIZE || iy > ICON_SIZE;
    if (outside) return null;
  }
  if (inCircle(ix, iy, spec.dot)) return DOT;
  if (
    inCircle(ix, iy, spec.crescent.outer) &&
    !inCircle(ix, iy, spec.crescent.inner)
  ) {
    return MOON;
  }
  return TILE;
}
