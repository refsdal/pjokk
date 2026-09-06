import { useSyncExternalStore } from "react";
import type { Baby } from "@pjokk/shared";
import { useBabies } from "./data";

// Which baby the app is showing (Home/Timeline/Stats). A tiny external
// store so every screen sees the same selection; persisted per device.

const KEY = "pjokk.selectedBaby";

let current: string | null = null;
try {
  current = localStorage.getItem(KEY);
} catch {
  // storage unavailable
}

const listeners = new Set<() => void>();

export function selectBaby(id: string) {
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable
  }
  for (const fn of listeners) fn();
}

// Forget the device's baby selection — a family switch leaves it pointing
// at a baby the new family does not have (it would self-heal to the first
// baby anyway; clearing keeps the reasoning simple).
export function clearSelectedBaby() {
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSelectedBaby(): {
  babies: ReturnType<typeof useBabies>;
  baby: Baby | undefined;
  selectBaby: (id: string) => void;
} {
  const babies = useBabies();
  const selectedId = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  const list = babies.data ?? [];
  const baby = list.find((b) => b.id === selectedId) ?? list[0];
  return { babies, baby, selectBaby };
}
