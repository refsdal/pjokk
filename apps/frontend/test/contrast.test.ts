import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Contrast guards for the three palettes in styles.css.
//
// Written after a real report: an installed PWA on an Android phone in dark
// mode showed a near-white status bar with the system's light glyphs over it,
// so the clock and notification icons were unreadable. Auditing the rest of
// the palette turned up three more that nobody had measured — most of all
// --color-on-accent, which dark mode never overrode, leaving the light
// theme's white text on the accent at 2.62:1 for every primary button.
//
// The point of these tests is that the numbers stop being a one-off audit: a
// token nudged "just a little" for looks fails here instead of shipping.
//
// Thresholds are WCAG 2.1: 4.5:1 for normal text (1.4.3), 3:1 for large text
// and for graphics that carry meaning (1.4.11). Hairlines and scrims are
// deliberately excluded — a divider is decoration, and holding it to 3:1
// would make it a border.

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const INIT = readFileSync(
  new URL("../public/theme-init.js", import.meta.url),
  "utf8",
);

/** Pulls the --color-* declarations out of one CSS block. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    const [, name, value] = m;
    if (name && value) out[name] = value.toLowerCase();
  }
  return out;
}

function blockAfter(marker: string): string {
  const start = CSS.indexOf(marker);
  if (start === -1) throw new Error(`no ${marker} block in styles.css`);
  const open = CSS.indexOf("{", start);
  return CSS.slice(open, CSS.indexOf("}", open));
}

const light = tokens(blockAfter("@theme"));
// Dark and night only override some tokens; the rest inherit from light.
const dark = { ...light, ...tokens(blockAfter(".dark")) };
const night = { ...light, ...tokens(blockAfter(".night")) };

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function ratio(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

/** A missing token is a broken test, not a silent undefined comparison. */
function token(t: Record<string, string>, name: string): string {
  const v = t[name];
  if (!v) throw new Error(`no --color-${name} in the palette`);
  return v;
}

const themes: [string, Record<string, string>][] = [
  ["light", light],
  ["dark", dark],
  ["night", night],
];

describe("palette contrast", () => {
  // 4.5:1 — body and secondary text at normal sizes.
  const TEXT: [string, string][] = [
    ["ink", "bg"],
    ["ink", "surface"],
    ["ink", "surface-2"],
    ["ink-soft", "bg"],
    ["muted", "bg"],
    ["muted", "surface"],
  ];

  for (const [name, t] of themes) {
    for (const [fg, bg] of TEXT) {
      it(`${name}: ${fg} on ${bg} is readable as normal text`, () => {
        const [f, b] = [token(t, fg), token(t, bg)];
        const r = ratio(f, b);
        expect(
          r,
          `${f} on ${b} = ${r.toFixed(2)}:1, want >= 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // 3:1 — meaningful graphics and text on filled controls.
  const GRAPHIC: [string, string][] = [
    ["on-accent", "accent"],
    ["accent", "bg"],
    ["danger", "bg"],
    ["sleep", "bg"],
    ["feed", "bg"],
    ["diaper", "bg"],
    ["growth", "bg"],
  ];

  for (const [name, t] of themes) {
    for (const [fg, bg] of GRAPHIC) {
      it(`${name}: ${fg} on ${bg} is distinguishable`, () => {
        const [f, b] = [token(t, fg), token(t, bg)];
        const r = ratio(f, b);
        expect(
          r,
          `${f} on ${b} = ${r.toFixed(2)}:1, want >= 3`,
        ).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("theme-init.js", () => {
  // It cannot import anything — it runs before the bundle exists — so it
  // carries its own copy of the three background colours. This is the guard
  // that keeps that copy honest: a palette change that misses it would put
  // the wrong status-bar colour on every cold start, which is the exact bug
  // this file was added to fix.
  it("uses the same backgrounds as styles.css", () => {
    for (const [name, t] of themes) {
      expect(INIT, `theme-init.js is missing the ${name} --color-bg`).toContain(
        token(t, "bg"),
      );
    }
  });

  it("reads the same storage keys the app writes", () => {
    for (const key of [
      "pjokk.theme.mode",
      "pjokk.night.mode",
      "pjokk.night.schedule",
    ]) {
      expect(INIT).toContain(key);
    }
  });
});
