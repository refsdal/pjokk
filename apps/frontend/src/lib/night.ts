import { useCallback, useEffect, useState } from "react";

// Scheduled night mode (default 22:00–07:00) with manual override and a
// configurable schedule. Stored locally per device — a nursery tablet and a
// phone can differ.

export type NightMode = "auto" | "on" | "off";
export type NightSchedule = { startHour: number; endHour: number };

const MODE_KEY = "pjokk.night.mode";
const SCHEDULE_KEY = "pjokk.night.schedule";
const DEFAULT_SCHEDULE: NightSchedule = { startHour: 22, endHour: 7 };

function readSchedule(): NightSchedule {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NightSchedule>;
      if (
        typeof parsed.startHour === "number" &&
        typeof parsed.endHour === "number"
      ) {
        return { startHour: parsed.startHour, endHour: parsed.endHour };
      }
    }
  } catch {
    // storage unavailable / corrupt
  }
  return DEFAULT_SCHEDULE;
}

function inNightWindow(schedule: NightSchedule, d = new Date()): boolean {
  const h = d.getHours();
  return schedule.startHour > schedule.endHour
    ? h >= schedule.startHour || h < schedule.endHour
    : h >= schedule.startHour && h < schedule.endHour;
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

// The device's night window, for anything else that wants the hours a
// parent already said they sleep in (reminder quiet hours default to it).
export function nightSchedule(): NightSchedule {
  return readSchedule();
}

// The default for a new sleep entry's nap/night type: "night" when the
// moment falls inside the device's scheduled night window, else "nap". The
// SCHEDULE alone decides — a manual "night on" at 14:00 is about the
// screen, not the baby — and the chip in the sheet is one tap away for the
// 19:00 bedtime the default window does not cover.
export function sleepTypeAt(
  d: Date,
  schedule: NightSchedule = readSchedule(),
): "nap" | "night" {
  return inNightWindow(schedule, d) ? "night" : "nap";
}

export function isNightActive(
  mode: NightMode = readMode(),
  schedule: NightSchedule = readSchedule(),
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return inNightWindow(schedule);
}

export function useNight() {
  const [mode, setModeState] = useState<NightMode>(readMode);
  const [schedule, setScheduleState] = useState<NightSchedule>(readSchedule);
  const [night, setNight] = useState(() => isNightActive());

  useEffect(() => {
    const apply = () => setNight(isNightActive(mode, schedule));
    apply();
    const timer = setInterval(apply, 30_000);
    return () => clearInterval(timer);
  }, [mode, schedule]);

  // (The theme-color meta is owned by AppearanceProvider, which also knows
  // about dark mode.)
  useEffect(() => {
    document.documentElement.classList.toggle("night", night);
  }, [night]);

  const setMode = useCallback((m: NightMode) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // storage unavailable
    }
    setModeState(m);
  }, []);

  const setSchedule = useCallback((s: NightSchedule) => {
    try {
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(s));
    } catch {
      // storage unavailable
    }
    setScheduleState(s);
  }, []);

  // A manual override flips relative to the current state; "auto" comes back
  // by explicit choice in settings.
  const toggle = useCallback(() => {
    setMode(night ? "off" : "on");
  }, [night, setMode]);

  return { night, mode, setMode, schedule, setSchedule, toggle };
}
