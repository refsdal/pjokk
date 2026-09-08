import { useEffect, useState } from "react";

// Screen behaviour for the care station (spec §7).

// Keeps the display on while the kiosk is mounted; re-requests after the
// tab was hidden (the lock is released then). Absent API: nothing.
export function useWakeLock(enabled = true): void {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        // Denied (low battery, tab not visible): the next visibility change
        // tries again.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [enabled]);
}

export const IDLE_MS = 120_000;
// How long the overlay keeps swallowing pointer events after the wake tap,
// so that tap can never also press what was underneath.
export const WAKE_SWALLOW_MS = 350;

export type IdleState = "awake" | "dim" | "waking";

export function useIdle(ms = IDLE_MS): [IdleState, () => void] {
  const [state, setState] = useState<IdleState>("awake");
  useEffect(() => {
    let timer = setTimeout(() => setState("dim"), ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setState("dim"), ms);
    };
    window.addEventListener("pointerdown", reset, true);
    window.addEventListener("keydown", reset, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", reset, true);
      window.removeEventListener("keydown", reset, true);
    };
  }, [ms]);
  const wake = () => {
    setState("waking");
    setTimeout(() => setState("awake"), WAKE_SWALLOW_MS);
  };
  return [state, wake];
}
