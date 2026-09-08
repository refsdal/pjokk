import { describe, expect, it } from "bun:test";
import { hotkeyFor, isTypingTarget } from "../src/lib/hotkeys";

// Spec §6: plain single keys on Home, ignored while typing and with any
// modifier held (browser shortcuts stay the browser's). No DOM in this
// suite, so targets are duck-typed {tagName, isContentEditable} objects —
// which is also why isTypingTarget must not use instanceof.
const fired: string[] = [];
const map = {
  f: () => fired.push("feed"),
  d: () => fired.push("diaper"),
  s: () => fired.push("sleep"),
};
const fire = (e: Parameters<typeof hotkeyFor>[0]): string | null => {
  fired.length = 0;
  const fn = hotkeyFor(e, map);
  if (!fn) return null;
  fn();
  return fired[0] ?? null;
};
const key = (
  k: string,
  extra: Partial<Parameters<typeof hotkeyFor>[0]> = {},
) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  target: { tagName: "BODY", isContentEditable: false },
  ...extra,
});

describe("hotkeyFor", () => {
  it("maps plain keys, case-insensitively", () => {
    expect(fire(key("f"))).toBe("feed");
    expect(fire(key("F"))).toBe("feed");
    expect(fire(key("s"))).toBe("sleep");
  });
  it("ignores unknown keys", () => {
    expect(hotkeyFor(key("x"), map)).toBeNull();
  });
  it("ignores any modifier", () => {
    expect(hotkeyFor(key("f", { ctrlKey: true }), map)).toBeNull();
    expect(hotkeyFor(key("f", { metaKey: true }), map)).toBeNull();
    expect(hotkeyFor(key("f", { altKey: true }), map)).toBeNull();
  });
  it("ignores keys typed into a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(
        hotkeyFor(
          key("f", { target: { tagName, isContentEditable: false } }),
          map,
        ),
      ).toBeNull();
    }
    expect(
      hotkeyFor(
        key("f", { target: { tagName: "DIV", isContentEditable: true } }),
        map,
      ),
    ).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("is false for nothing and for plain elements", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(
      isTypingTarget({ tagName: "BUTTON", isContentEditable: false }),
    ).toBe(false);
  });
});
