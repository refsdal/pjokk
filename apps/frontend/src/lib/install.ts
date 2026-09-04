// "Add to Home Screen" plumbing.
//
// Why this exists: iOS never fires an install prompt. Chromium fires
// `beforeinstallprompt` and hands you a button; WebKit has no equivalent and
// never will, so the only route onto an iPhone home screen is Share -> Add to
// Home Screen — a menu item the app previously never mentioned anywhere. A
// real user went looking for it and gave up.
//
// The hard part is not showing a hint, it is showing the RIGHT hint: inside a
// Facebook or Mail webview that menu item does not exist at all, so the
// Safari instructions are not merely unhelpful there, they are impossible to
// follow. Hence the state machine below rather than a single `isIOS` flag.

import { useMemo, useSyncExternalStore } from "react";

// Third-party iOS browsers. All of them are WebKit underneath (App Store
// policy), but each has its own share menu, so we point at Safari rather than
// describe four different menus we cannot test.
const IOS_BROWSER_TOKENS = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo/;

export type InstallState =
  /** Already on the home screen — nothing to offer. */
  | "installed"
  /** Chromium handed us a real prompt; show a button that fires it. */
  | "prompt-available"
  /** iOS Safari: Share -> Add to Home Screen works, so say exactly that. */
  | "ios-safari"
  /** iOS, but in a webview or third-party browser where that menu is absent. */
  | "ios-needs-safari"
  /** Desktop or anything else with no install path worth explaining. */
  | "unsupported";

export type InstallEnv = {
  userAgent: string;
  /** `navigator.standalone` — iOS-only, and absent on other platforms. */
  standalone: boolean;
  /** `matchMedia("(display-mode: standalone)").matches`. */
  displayModeStandalone: boolean;
  /** A `beforeinstallprompt` event has been captured and is still usable. */
  hasPrompt: boolean;
  /** `navigator.maxTouchPoints` — the only way to tell iPadOS from macOS. */
  maxTouchPoints: number;
};

// iPadOS 13+ reports itself as "Macintosh; Intel Mac OS X" with a desktop
// Safari UA. Touch points are the documented tell-tale, and a Mac with a
// touch bar still reports 0, so this does not catch real desktops.
function isIOS(env: InstallEnv): boolean {
  if (/iPad|iPhone|iPod/.test(env.userAgent)) return true;
  return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}

// Real Safari carries BOTH a Version/ token and a Safari/ token. In-app
// webviews carry neither; Chrome/Firefox/Edge on iOS carry Safari/ but never
// Version/, and are caught by their own token besides. Requiring both is what
// keeps every non-Safari case out of the branch that says "tap Share".
function isRealSafari(ua: string): boolean {
  if (IOS_BROWSER_TOKENS.test(ua)) return false;
  return /Version\/\d/.test(ua) && /Safari\//.test(ua);
}

/**
 * Chromium's install event. Not in lib.dom yet, and deliberately minimal —
 * only the two members we use.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
};

export function detectInstallState(env: InstallEnv): InstallState {
  // Installed wins over everything: a captured prompt can outlive the install
  // that consumed it, and offering "install" to an installed app is a bug the
  // user can see.
  if (env.displayModeStandalone || env.standalone) return "installed";
  // iOS is checked BEFORE the prompt: WebKit never fires
  // beforeinstallprompt, so a prompt on an iOS user agent can only come from
  // an emulated environment, and the WebKit rules are what a real device will
  // follow.
  if (isIOS(env)) {
    return isRealSafari(env.userAgent) ? "ios-safari" : "ios-needs-safari";
  }
  if (env.hasPrompt) return "prompt-available";
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Browser layer
//
// Everything below reads live browser state, so it is exercised by
// e2e/install.spec.ts rather than the unit suite (which has no DOM). Note
// that NOTHING here touches `window` or `localStorage` at module scope: the
// unit test imports this file for detectInstallState, and a top-level
// storage read — the idiom the other stores in this directory use — would
// crash it on import.
// ---------------------------------------------------------------------------

const DISMISS_KEY = "pjokk.install.dismissed";

let promptEvent: BeforeInstallPromptEvent | null = null;
let dismissed: boolean | null = null;
let version = 0;

const listeners = new Set<() => void>();

function emit() {
  version += 1;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const getVersion = () => version;

function readEnv(): InstallEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent,
    // iOS-only; `=== true` because it is simply absent elsewhere.
    standalone: nav.standalone === true,
    displayModeStandalone:
      window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    hasPrompt: promptEvent !== null,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
  };
}

/**
 * Captures Chromium's install prompt. Called once from main.tsx — the event
 * fires early, so a listener registered later than app start misses it
 * outright.
 */
export function initInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Suppress Chromium's own mini-infobar; the app has its own, calmer
    // affordance and two competing install prompts is worse than either.
    e.preventDefault();
    promptEvent = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    // The captured event is spent, and the state is now "installed".
    promptEvent = null;
    emit();
  });
}

/** Fires the captured prompt. A prompt may only be used once. */
export async function promptInstall(): Promise<void> {
  const event = promptEvent;
  if (!event) return;
  promptEvent = null;
  emit();
  await event.prompt();
}

export function useInstallState(): InstallState {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `v` is the
  // store's version counter — it exists precisely to re-read browser state
  // that React cannot see change.
  return useMemo(() => detectInstallState(readEnv()), [v]);
}

function readDismissed(): boolean {
  if (dismissed === null) {
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      // storage unavailable
      dismissed = false;
    }
  }
  return dismissed;
}

export function useInstallHintDismissed(): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return readDismissed();
}

/** Permanent per device: Settings keeps the instructions reachable after. */
export function dismissInstallHint(): void {
  dismissed = true;
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // storage unavailable — the banner returns next load, which is a
    // nuisance rather than a fault.
  }
  emit();
}
