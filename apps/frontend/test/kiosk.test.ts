import { describe, expect, it } from "bun:test";
import {
  disableKiosk,
  enableKiosk,
  hashPin,
  isKioskOn,
  isValidPin,
  type StorageLike,
  storedPinLength,
  verifyPin,
} from "../src/lib/kiosk";

// The kiosk flag and PIN are device state (spec §1). No DOM here, so every
// function takes a storage; the app passes localStorage.
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

describe("hashPin", () => {
  it("is deterministic, hex, and domain-separated from a bare sha256", async () => {
    const a = await hashPin("1234");
    expect(a).toBe(await hashPin("1234"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // sha256("1234") — must NOT be what we store.
    expect(a).not.toBe(
      "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
    );
  });
});

describe("enable / verify / disable", () => {
  it("round-trips through storage", async () => {
    const s = memory();
    expect(isKioskOn(s)).toBe(false);
    await enableKiosk("2580", s);
    expect(isKioskOn(s)).toBe(true);
    expect(storedPinLength(s)).toBe(4);
    expect(await verifyPin("2580", s)).toBe(true);
    expect(await verifyPin("2581", s)).toBe(false);
    expect(await verifyPin("258", s)).toBe(false);
    disableKiosk(s);
    expect(isKioskOn(s)).toBe(false);
    expect(storedPinLength(s)).toBeNull();
  });

  it("refuses to enable with an invalid PIN", async () => {
    const s = memory();
    await expect(enableKiosk("12", s)).rejects.toThrow();
    expect(isKioskOn(s)).toBe(false);
  });
});
