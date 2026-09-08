import { useEffect, useRef } from "react";

// Single-key shortcuts for Home (spec §6): F / D / S open the sheets. Not
// tier-gated — a Bluetooth keyboard on a tablet gets them too — and never
// with a modifier, so nothing the browser owns is shadowed.

export type HotkeyMap = Record<string, () => void>;

type KeyLike = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target:
    | EventTarget
    | { tagName?: string; isContentEditable?: boolean }
    | null;
};

// Duck-typed rather than instanceof: the unit suite has no DOM.
export function isTypingTarget(target: KeyLike["target"]): boolean {
  const el = target as {
    tagName?: string;
    isContentEditable?: boolean;
  } | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

export function hotkeyFor(e: KeyLike, map: HotkeyMap): (() => void) | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  if (isTypingTarget(e.target)) return null;
  return map[e.key.toLowerCase()] ?? null;
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  // The newest map without re-subscribing on every render.
  const latest = useRef(map);
  useEffect(() => {
    latest.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const fn = hotkeyFor(e, latest.current);
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
