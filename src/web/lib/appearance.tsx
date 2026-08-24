import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useNight } from "./night";

// Two independent layers:
//  - theme (system/light/dark): normal visual preference
//  - night mode (22–07 amber): overrides everything while active
// Both are device-local. CSS ordering makes .night win over .dark.

export type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "pjokk.theme.mode";

function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable
  }
  return "system";
}

type AppearanceValue = ReturnType<typeof useNight> & {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  dark: boolean;
};

const AppearanceContext = createContext<AppearanceValue | null>(null);

export function useAppearance(): AppearanceValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance outside AppearanceProvider");
  return ctx;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const nightValue = useNight();
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readThemeMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const dark =
    themeMode === "dark" || (themeMode === "system" && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const color = nightValue.night
      ? "#171310"
      : dark
        ? "#171512"
        : "#faf9f7";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
  }, [nightValue.night, dark]);

  const setThemeMode = useCallback((m: ThemeMode) => {
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      // storage unavailable
    }
    setThemeModeState(m);
  }, []);

  return (
    <AppearanceContext.Provider
      value={{ ...nightValue, themeMode, setThemeMode, dark }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}
