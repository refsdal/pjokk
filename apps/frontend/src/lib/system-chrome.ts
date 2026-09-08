// The colour the OS paints its own chrome with — Android's status bar, and
// the toolbar tint in a mobile browser. It is NOT a page colour: the page's
// background is --color-bg in styles.css, and these three values only track
// it so the two do not visibly disagree.
//
// Why this is a module rather than one line in AppearanceProvider:
//
// An installed Android app is a WebAPK, and the manifest's `theme_color` is
// baked into it when the APK is generated (https://web.dev/articles/webapks).
// That is ONE static colour, chosen at install time, and no per-device in-app
// theme can move it. Chrome keeps reading the live <meta name="theme-color">
// for the *glyph* colour, though — so an app whose meta says dark over a bar
// baked light gets light glyphs on a light bar, and the clock and the
// notification icons disappear. That was a real report, in dark mode, on a
// real phone, and the OS theme made no difference to it because nothing in
// the chain reads the OS theme.
//
// Making the meta correct earlier (public/theme-init.js) fixed the flash and
// the glyph decision but could not fix the background, because the background
// was decided before the app ever ran. Since the baked colour cannot follow
// the theme, the meta must stop trying to: an installed app always reports
// dark, and the manifest is dark to match (apps/frontend/vite.config.ts), so
// the two agree in every theme. In a browser tab there is nothing baked — the
// meta drives the bar itself — so there the colour tracks the theme exactly
// as before, and the light theme keeps its light chrome.
//
// The cost is honest and deliberate: an installed app in the LIGHT theme has
// a dark status bar above a light screen. That is the only readable option on
// the wrong side of a one-colour manifest, and it is the side that keeps
// night mode near-black (product principle 6) instead of putting a white
// strip above a parent's face at 3am.

/** --color-bg of the light palette. */
export const SYSTEM_CHROME_LIGHT = "#faf9f7";
/** --color-bg of the dark palette; also the locked colour when installed. */
export const SYSTEM_CHROME_DARK = "#171512";
/** --color-bg of the night palette. */
export const SYSTEM_CHROME_NIGHT = "#171310";
/** --color-bg of the kiosk palette (the care station, spec §3). */
export const SYSTEM_CHROME_KIOSK = "#131a21";

export type SystemChromeEnv = {
  night: boolean;
  dark: boolean;
  /** Running as an installed app rather than in a browser tab. */
  standalone: boolean;
  /** Kiosk mode is on for this device (lib/kiosk.ts). Night still wins. */
  kiosk?: boolean;
};

export function systemChromeColor({
  night,
  dark,
  standalone,
  kiosk = false,
}: SystemChromeEnv): string {
  if (night) return SYSTEM_CHROME_NIGHT;
  if (kiosk) return SYSTEM_CHROME_KIOSK;
  return dark || standalone ? SYSTEM_CHROME_DARK : SYSTEM_CHROME_LIGHT;
}

// `fullscreen` and `minimal-ui` are listed with `standalone` because all
// three are launched-from-the-home-screen modes with a baked theme colour;
// only `browser` has none. The manifest asks for `standalone`, but a
// display-mode fallback chain or a future change should not quietly
// reintroduce the bug.
export const STANDALONE_QUERY =
  "(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)";

export function isStandaloneDisplay(): boolean {
  return window.matchMedia?.(STANDALONE_QUERY).matches ?? false;
}
