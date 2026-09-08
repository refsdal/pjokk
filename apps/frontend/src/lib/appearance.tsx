import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  getLanguageMode,
  setLanguageMode as applyLanguageMode,
  type LanguageMode,
} from "./i18n";
import { useKiosk } from "./kiosk";
import { useNight } from "./night";
import { STANDALONE_QUERY, systemChromeColor } from "./system-chrome";

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
  /** Kiosk mode (lib/kiosk.ts) is on for this device. */
  kiosk: boolean;
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  dark: boolean;
  languageMode: LanguageMode;
  setLanguage: (m: LanguageMode) => void;
};

const AppearanceContext = createContext<AppearanceValue | null>(null);

export function useAppearance(): AppearanceValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance outside AppearanceProvider");
  return ctx;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const nightValue = useNight();
  const kiosk = useKiosk();
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readThemeMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  // Whether we are running as an installed app. It decides the status-bar
  // colour (see lib/system-chrome.ts) and it is not fixed for the life of the
  // tab: accepting Chrome's install prompt flips it under a running page.
  const [standalone, setStandalone] = useState(
    () => window.matchMedia?.(STANDALONE_QUERY).matches ?? false,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(STANDALONE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setStandalone(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const dark = themeMode === "dark" || (themeMode === "system" && systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // The care station's palette rides on the same <html> class mechanism;
  // public/theme-init.js sets it before the first paint, this keeps it true.
  useEffect(() => {
    document.documentElement.classList.toggle("kiosk", kiosk);
  }, [kiosk]);

  useEffect(() => {
    const color = systemChromeColor({
      night: nightValue.night,
      dark,
      standalone,
      kiosk,
    });
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
  }, [nightValue.night, dark, standalone, kiosk]);

  const setThemeMode = useCallback((m: ThemeMode) => {
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      // storage unavailable
    }
    setThemeModeState(m);
  }, []);

  // Language: t() reads a module-level dictionary; this state exists purely
  // to re-render the tree when the language changes.
  const [languageMode, setLanguageModeState] =
    useState<LanguageMode>(getLanguageMode);
  const setLanguage = useCallback((m: LanguageMode) => {
    applyLanguageMode(m);
    setLanguageModeState(m);
  }, []);

  return (
    <AppearanceContext.Provider
      value={{
        ...nightValue,
        kiosk,
        themeMode,
        setThemeMode,
        dark,
        languageMode,
        setLanguage,
      }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}
