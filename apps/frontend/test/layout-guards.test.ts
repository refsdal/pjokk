import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Structural guards for the responsive shell (spec, Testing).
//
// The side-panel behaviour lives in ONE place (components/Sheet.tsx is the
// only vaul import), and the rail is CSS-only (TabBar.tsx never reads the
// tier in JS). Both are easy to undo by accident — a second Drawer.Root
// somewhere, or a "quick" `useTier()` in the nav — so they are checked here
// the way contrast.test.ts checks the palette.
const SRC = join(import.meta.dir, "..", "src");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

describe("responsive shell guards", () => {
  it("only components/Sheet.tsx imports vaul", () => {
    const importers = [...walk(SRC)]
      .filter((p) => /from\s+["']vaul["']/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1));
    expect(importers).toEqual(["components/Sheet.tsx"]);
  });

  it("the tab bar / rail is CSS-only (no useTier in TabBar.tsx)", () => {
    const src = readFileSync(join(SRC, "components", "TabBar.tsx"), "utf8");
    expect(src).not.toContain("useTier");
    // The rail exists: the nav carries md: classes that move it to the left.
    expect(src).toContain("md:left-0");
    expect(src).toContain("md:flex-col");
  });

  it(".pb-tabbar stops clearing the bottom bar at md and up", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(
      /@media \(min-width: 768px\)\s*\{\s*\.pb-tabbar\s*\{\s*padding-bottom: 1\.5rem;\s*\}\s*\}/,
    );
  });

  it("the kiosk never imports the app's sheets, nav or hotkeys", () => {
    const files = [
      ...walk(join(SRC, "components", "kiosk")),
      join(SRC, "screens", "Kiosk.tsx"),
    ];
    expect(files.length).toBeGreaterThan(1);
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      for (const banned of [
        "components/Sheet",
        "components/TabBar",
        "components/HomeActions",
        "lib/hotkeys",
      ]) {
        expect(src, `${p} imports ${banned}`).not.toContain(banned);
      }
    }
  });
});
