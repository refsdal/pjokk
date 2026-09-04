// Renders the PNG app icons from the same mark as icon.svg.
//
//   node scripts/gen-icons.mjs
//
// Why PNGs exist at all when icon.svg already does: WebKit does not accept an
// SVG for `apple-touch-icon`, and does not accept SVG icons in a web app
// manifest. An iPhone adding Pjokk to the home screen with only SVGs on offer
// falls back to a SCREENSHOT OF THE PAGE as the icon. The SVGs stay — every
// other engine prefers them, and they stay crisp — these are the fallback
// that makes iOS behave.
//
// Every PNG here is FULL-BLEED — the tile runs edge to edge, with none of
// icon.svg's rounded corners. That is what each consumer wants: iOS applies
// its own rounded mask to an apple-touch-icon (ours would round it twice),
// and a maskable icon must fill the square by definition. It is also the only
// thing this encoder can express — it writes RGB with no alpha channel, so a
// "rounded" PNG would just have tile-coloured corners regardless. icon.svg
// keeps the rounding for every engine that takes an SVG.
//
// Sizes:
//   icon-180.png           apple-touch-icon (the one WebKit needs)
//   icon-192/512.png       manifest, purpose "any"
//   icon-maskable-512.png  manifest, purpose "maskable" — the smaller mark
//                          from icon-maskable.svg, inside the safe zone

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ICON_SIZE,
  MASKABLE,
  sampleMark,
  STANDARD,
  TILE,
} from "./lib/mark.mjs";
import { encodePng } from "./lib/png.mjs";

const FRONTEND = new URL("../apps/frontend/public/", import.meta.url);
const LANDING = new URL("../apps/landing/public/", import.meta.url);

/** @param spec  STANDARD or MASKABLE (see the full-bleed note above) */
function render(size, spec) {
  const effective = { ...spec, radius: 0 };
  const scale = ICON_SIZE / size;
  return encodePng(
    size,
    size,
    (px, py) =>
      // Outside the tile there is nothing behind these icons, so an
      // unmasked pixel is simply the tile colour.
      sampleMark(px * scale, py * scale, effective) ?? TILE,
  );
}

const outputs = [
  ["icon-180.png", render(180, STANDARD), [FRONTEND, LANDING]],
  ["icon-192.png", render(192, STANDARD), [FRONTEND]],
  ["icon-512.png", render(512, STANDARD), [FRONTEND]],
  ["icon-maskable-512.png", render(512, MASKABLE), [FRONTEND]],
];

for (const [name, buf, dirs] of outputs) {
  for (const dir of dirs) {
    writeFileSync(fileURLToPath(new URL(name, dir)), buf);
  }
  console.log(`${name}: ${(buf.length / 1024).toFixed(1)} kB`);
}
