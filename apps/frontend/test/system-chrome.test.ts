import { describe, expect, it } from "bun:test";
import {
  SYSTEM_CHROME_DARK,
  SYSTEM_CHROME_LIGHT,
  SYSTEM_CHROME_NIGHT,
  systemChromeColor,
} from "../src/lib/system-chrome";

// The second half of the Android status-bar bug (the first half is covered by
// test/theme-init.test.ts and e2e/theme.spec.ts).
//
// Reported from a real installed app, and NOT fixed by making the theme-color
// meta correct before the first paint: with the app in dark mode the status
// bar stayed near-white while the system drew its light glyphs over it, so the
// clock and notification icons were invisible. The OS theme made no difference
// — only the app's own theme did.
//
// That matrix only has one explanation. An installed Android app is a WebAPK,
// and `theme_color` from the manifest is baked into it when it is generated
// (https://web.dev/articles/webapks) — one static colour, chosen long before
// the user picks a theme, and ours was the light #faf9f7. Chrome keeps taking
// the *glyph* colour from the live theme-color meta, which theme-init.js now
// correctly turns dark. Light glyphs, light bar.
//
// A manifest holds ONE colour, so the bar can never follow a per-device
// in-app theme: whichever value is baked in, one of the two themes ends up
// with matching glyphs. The only readable arrangement is to stop the two
// disagreeing, so an installed app always reports a dark colour and the
// manifest is dark to match. In a browser tab the meta drives the bar itself,
// so nothing is baked and nothing is locked — the colour tracks the theme, as
// it always did.
//
// Every value here must be dark EXCEPT light-theme-in-a-browser. That is the
// whole invariant, and it is why light + standalone looks like a mistake and
// is not one.

const luminance = (hex: string): number => {
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
};

describe("systemChromeColor", () => {
  it("tracks the theme in a browser tab", () => {
    expect(
      systemChromeColor({ night: false, dark: false, standalone: false }),
    ).toBe(SYSTEM_CHROME_LIGHT);
    expect(
      systemChromeColor({ night: false, dark: true, standalone: false }),
    ).toBe(SYSTEM_CHROME_DARK);
  });

  it("never reports a light colour to an installed app", () => {
    // The bug itself: light bar, light glyphs. The app's own theme is still
    // light here — this is the OS chrome above it, nothing more.
    expect(
      systemChromeColor({ night: false, dark: false, standalone: true }),
    ).toBe(SYSTEM_CHROME_DARK);
    expect(
      systemChromeColor({ night: false, dark: true, standalone: true }),
    ).toBe(SYSTEM_CHROME_DARK);
  });

  it("keeps night mode's own near-black in both", () => {
    // Night is already dark, so it needs no locking — and it must not be
    // flattened into the dark theme's colour, which is a different warmth.
    for (const standalone of [false, true]) {
      for (const dark of [false, true]) {
        expect(systemChromeColor({ night: true, dark, standalone })).toBe(
          SYSTEM_CHROME_NIGHT,
        );
      }
    }
  });

  it("is dark in every combination an installed app can reach", () => {
    // The invariant stated as a property rather than a list: whatever the
    // resolution rules grow into, a WebAPK must never be handed a colour the
    // system will answer with light glyphs.
    for (const night of [false, true]) {
      for (const dark of [false, true]) {
        const color = systemChromeColor({ night, dark, standalone: true });
        expect(
          luminance(color),
          `${color} (night=${night} dark=${dark}) is too light for a baked status bar`,
        ).toBeLessThan(0.1);
      }
    }
  });
});
