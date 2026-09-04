// Renders apps/landing/public/og.png — the 1200x630 link-preview card for
// pjokk.no. The landing site is its own deploy with its own asset directory
// (apps/frontend/public/ keeps the SPA's copy), so this writes here, not
// there.
//
//   node apps/landing/scripts/gen-og.mjs
//
// The PNG encoder and the mark's geometry moved to scripts/lib/ when the PWA
// icons needed the same two things; this file is now just the card's layout.
//
// The re-render is not byte-identical to the pre-refactor one: 27 subpixels
// of 2,268,000 change, by at most 9/255, all on curve edges. The old arc
// centres were hardcoded to three decimals; scripts/lib/png.mjs derives them
// exactly from the path endpoints instead, so the new output is the more
// faithful of the two.
//
// There is no wordmark because rendering text would need a font dependency;
// every platform that shows this card renders og:title and og:description as
// text beside it anyway.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CARD,
  ICON_SIZE,
  sampleMark,
  STANDARD,
} from "../../../scripts/lib/mark.mjs";
import { encodePng } from "../../../scripts/lib/png.mjs";

const W = 1200;
const H = 630;

// The icon tile is placed 340px across, centred, and every test happens in
// the icon's own coordinates so this stays a faithful reproduction.
const BOX = 340;

function sample(px, py) {
  const scale = ICON_SIZE / BOX;
  const ix = ICON_SIZE / 2 + (px - W / 2) * scale;
  const iy = ICON_SIZE / 2 + (py - H / 2) * scale;
  return sampleMark(ix, iy, STANDARD) ?? CARD;
}

const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
const buf = encodePng(W, H, sample);
writeFileSync(out, buf);
console.log(`og.png written: ${W}x${H}, ${(buf.length / 1024).toFixed(1)} kB`);
