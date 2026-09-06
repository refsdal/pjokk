import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SYSTEM_CHROME_DARK,
  SYSTEM_CHROME_LIGHT,
  SYSTEM_CHROME_NIGHT,
} from "../src/lib/system-chrome";

// public/theme-init.js runs before the bundle exists, so it cannot import
// lib/system-chrome.ts and carries its own copy of the same rules. Copies rot.
// contrast.test.ts already pins its three background colours against
// styles.css; this file pins its BEHAVIOUR against the real module, by
// executing the shipped file against a stub DOM.
//
// The standalone branch is the reason it matters. An installed Android app
// takes its status-bar background from the manifest's baked theme_color and
// its glyph colour from this meta, so a light value here is invisible glyphs
// on a real phone — and theme-init.js is what sets the meta on every cold
// start. See test/system-chrome.test.ts for the full account.

const INIT = readFileSync(
  new URL("../public/theme-init.js", import.meta.url),
  "utf8",
);

type Env = {
  theme?: string | null;
  nightMode?: string | null;
  schedule?: string | null;
  systemDark?: boolean;
  standalone?: boolean;
};

type Result = { color: string; classes: string[] };

/**
 * Runs the shipped file with `document`, `localStorage` and `window` bound as
 * parameters — they shadow the real globals, so no global state is touched
 * and the file needs no modification to be testable.
 */
function runInit(env: Env): Result {
  const stored: Record<string, string | null> = {
    "pjokk.theme.mode": env.theme ?? null,
    "pjokk.night.mode": env.nightMode ?? "off",
    "pjokk.night.schedule": env.schedule ?? null,
  };

  const classes = new Set<string>();
  let color = SYSTEM_CHROME_LIGHT;

  const documentStub = {
    documentElement: {
      classList: {
        toggle(name: string, on: boolean) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
    },
    querySelector(selector: string) {
      if (!selector.includes("theme-color")) return null;
      return {
        setAttribute(_name: string, value: string) {
          color = value;
        },
      };
    },
  };

  const localStorageStub = {
    getItem: (key: string) => stored[key] ?? null,
  };

  const windowStub = {
    matchMedia: (query: string) => ({
      matches: query.includes("display-mode")
        ? (env.standalone ?? false)
        : (env.systemDark ?? false),
    }),
  };

  new Function("document", "localStorage", "window", INIT)(
    documentStub,
    localStorageStub,
    windowStub,
  );

  return { color, classes: [...classes] };
}

describe("theme-init.js", () => {
  it("tracks the theme in a browser tab", () => {
    expect(runInit({ theme: "light" }).color).toBe(SYSTEM_CHROME_LIGHT);
    expect(runInit({ theme: "dark" }).color).toBe(SYSTEM_CHROME_DARK);
  });

  it("follows the device when the theme is left on system", () => {
    expect(runInit({ theme: "system", systemDark: true }).color).toBe(
      SYSTEM_CHROME_DARK,
    );
    expect(runInit({ theme: "system", systemDark: false }).color).toBe(
      SYSTEM_CHROME_LIGHT,
    );
  });

  it("never reports a light colour to an installed app", () => {
    // The reported bug, at the layer that ships it: a light theme-color on a
    // WebAPK is white glyphs on a white bar.
    expect(runInit({ theme: "light", standalone: true }).color).toBe(
      SYSTEM_CHROME_DARK,
    );
    expect(
      runInit({ theme: "system", systemDark: false, standalone: true }).color,
    ).toBe(SYSTEM_CHROME_DARK);
  });

  it("keeps night mode's near-black, installed or not", () => {
    for (const standalone of [false, true]) {
      const r = runInit({ theme: "light", nightMode: "on", standalone });
      expect(r.color).toBe(SYSTEM_CHROME_NIGHT);
      expect(r.classes).toContain("night");
    }
  });

  it("still applies the theme classes before the paint", () => {
    // The half of the file that was already right; a standalone check must
    // not cost it.
    expect(runInit({ theme: "dark" }).classes).toContain("dark");
    expect(runInit({ theme: "light" }).classes).not.toContain("dark");
  });
});
