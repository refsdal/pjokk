import { useSyncExternalStore } from "react";

// Kiosk mode's device state (spec §1): a flag and a PIN hash in
// localStorage, like night mode and the nap guide. The PIN is a convenience
// lock against toddlers and guests, not a security boundary — the tablet
// holds a full session cookie regardless, and spec 3 replaces this with a
// device credential. A tiny external store so the shell can redirect and
// the AppearanceProvider can toggle the `kiosk` class.

export type StorageLike = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

export const ON_KEY = "pjokk.kiosk.on";
export const PIN_KEY = "pjokk.kiosk.pin";
export const PIN_LEN_KEY = "pjokk.kiosk.pinlen";
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

// Domain-separated so the stored value is never sha256(pin) itself.
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`pjokk-kiosk:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

export async function enableKiosk(
  pin: string,
  storage: StorageLike = defaultStorage(),
): Promise<void> {
  if (!isValidPin(pin)) throw new Error("PIN must be 4–6 digits");
  const hash = await hashPin(pin);
  storage.setItem(PIN_KEY, hash);
  storage.setItem(PIN_LEN_KEY, String(pin.length));
  storage.setItem(ON_KEY, "1");
  on = true;
  notify();
}

export function disableKiosk(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(ON_KEY);
  storage.removeItem(PIN_KEY);
  storage.removeItem(PIN_LEN_KEY);
  on = false;
  notify();
}

export async function verifyPin(
  pin: string,
  storage: StorageLike = defaultStorage(),
): Promise<boolean> {
  const stored = storage.getItem(PIN_KEY);
  if (!stored) return true; // no PIN recorded: nothing to guard
  return (await hashPin(pin)) === stored;
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
