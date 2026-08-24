import { useCallback, useEffect, useState } from "react";

// Scheduled night mode (default 22:00–07:00) with manual override.
// Stored locally per device — a nursery tablet and a phone can differ.

export type NightMode = "auto" | "on" | "off";

const MODE_KEY = "pjokk.night.mode";
const SCHEDULE = { startHour: 22, endHour: 7 };

function inNightWindow(d = new Date()): boolean {
  const h = d.getHours();
  return h >= SCHEDULE.startHour || h < SCHEDULE.endHour;
}

function readMode(): NightMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "on" || v === "off" || v === "auto") return v;
  } catch {
    // storage unavailable
  }
  return "auto";
}

export function isNightActive(mode: NightMode = readMode()): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return inNightWindow();
}

export function useNight() {
  const [mode, setModeState] = useState<NightMode>(readMode);
  const [night, setNight] = useState(() => isNightActive(readMode()));

  useEffect(() => {
    const apply = () => setNight(isNightActive(mode));
    apply();
    const timer = setInterval(apply, 30_000);
    return () => clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    document.documentElement.classList.toggle("night", night);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", night ? "#171310" : "#faf9f7");
  }, [night]);

  const setMode = useCallback((m: NightMode) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // storage unavailable
    }
    setModeState(m);
  }, []);

  // A manual override flips relative to the current state; "auto" comes back
  // by explicit choice in settings.
  const toggle = useCallback(() => {
    setMode(night ? "off" : "on");
  }, [night, setMode]);

  return { night, mode, setMode, toggle };
}
