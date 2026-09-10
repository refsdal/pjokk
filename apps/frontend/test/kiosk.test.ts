import { describe, expect, it } from "bun:test";
import {
  clearKioskFlags,
  isKioskOn,
  isValidPin,
  LEGACY_PIN_KEY,
  markEnrolled,
  type StorageLike,
  storedPinLength,
} from "../src/lib/kiosk";

// The kiosk's device-side state (spec 2026-09-10-kiosk-devices §6). The
// credential itself is an HttpOnly cookie script cannot see, so the device
// keeps only a routing flag and the PIN's length (the pad submits on the
// last digit). No DOM here, so every function takes a storage; the app
// passes localStorage.
function memory(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("isValidPin", () => {
  it("accepts 4–6 digits and nothing else", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });
});

describe("markEnrolled / clearKioskFlags", () => {
  it("turns the flag on and remembers how long the PIN is", () => {
    const s = memory();
    expect(isKioskOn(s)).toBe(false);
    markEnrolled(6, s);
    expect(isKioskOn(s)).toBe(true);
    expect(storedPinLength(s)).toBe(6);
  });

  it("refuses a length no PIN can have", () => {
    const s = memory();
    expect(() => markEnrolled(3, s)).toThrow();
    expect(isKioskOn(s)).toBe(false);
  });

  it("clears the flag, the length, and spec 2's local PIN hash", () => {
    const s = memory();
    s.setItem(LEGACY_PIN_KEY, "a-spec-2-hash");
    markEnrolled(4, s);
    clearKioskFlags(s);
    expect(isKioskOn(s)).toBe(false);
    expect(storedPinLength(s)).toBeNull();
    expect(s.getItem(LEGACY_PIN_KEY)).toBeNull();
  });
});
