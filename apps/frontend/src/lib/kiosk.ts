import { useSyncExternalStore } from "react";
import { resetCache } from "./query";

// Kiosk mode's device-side state (spec 2026-09-10-kiosk-devices §6). The
// tablet's credential is the HttpOnly pjokk_device cookie, which script
// cannot see, so what lives here is only what the SPA needs before the
// server has answered: a routing flag, so every app route lands on /kiosk
// at once (AppShell), and the PIN's length, so the pad knows when the last
// digit is in. The PIN itself is checked by the server
// (POST /api/device/unenrol) — it is no longer stored on the device.

export type StorageLike = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

export const ON_KEY = "pjokk.kiosk.on";
export const PIN_LEN_KEY = "pjokk.kiosk.pinlen";
// Spec 2's local PIN hash. Nothing writes it any more; clearKioskFlags
// removes it from a tablet that was a kiosk the old way.
export const LEGACY_PIN_KEY = "pjokk.kiosk.pin";
export const PIN_MIN = 4;
export const PIN_MAX = 6;

const noStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function defaultStorage(): StorageLike {
  try {
    return typeof localStorage === "undefined" ? noStorage : localStorage;
  } catch {
    return noStorage;
  }
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

export function isKioskOn(storage: StorageLike = defaultStorage()): boolean {
  try {
    return storage.getItem(ON_KEY) === "1";
  } catch {
    return false;
  }
}

export function storedPinLength(
  storage: StorageLike = defaultStorage(),
): number | null {
  try {
    const n = Number(storage.getItem(PIN_LEN_KEY));
    return Number.isInteger(n) && n >= PIN_MIN && n <= PIN_MAX ? n : null;
  } catch {
    return null;
  }
}

// --- the store -------------------------------------------------------------
let on = isKioskOn();
const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}

/** Enrolment succeeded: this browser is now the family's kiosk. */
export function markEnrolled(
  pinLength: number,
  storage: StorageLike = defaultStorage(),
): void {
  if (
    !Number.isInteger(pinLength) ||
    pinLength < PIN_MIN ||
    pinLength > PIN_MAX
  ) {
    throw new Error("PIN must be 4–6 digits");
  }
  storage.setItem(PIN_LEN_KEY, String(pinLength));
  storage.setItem(ON_KEY, "1");
  on = true;
  notify();
}

/** Forget that this browser is a kiosk (including a spec-2 local PIN). */
export function clearKioskFlags(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(ON_KEY);
  storage.removeItem(PIN_LEN_KEY);
  storage.removeItem(LEGACY_PIN_KEY);
  on = false;
  notify();
}

// Set for the rest of the page's life once leaving starts — the full load
// that follows wipes it. It keeps DeviceGate quiet while the cache it
// watches is torn down under it: the refetches that follow answer
// NOT_A_DEVICE (the cookie is already gone), which would otherwise read as
// "a kiosk set up the old way" and race the load to /login.
let leaving = false;

export function isLeavingKiosk(): boolean {
  return leaving;
}

// Leaving, or being revoked: the flags AND everything cached, in memory and
// on disk. One family's data does not stay on a tablet that is no longer
// theirs. Callers follow it with a full page load.
export async function leaveKiosk(): Promise<void> {
  leaving = true;
  clearKioskFlags();
  await resetCache();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useKiosk(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => on,
    () => false,
  );
}
