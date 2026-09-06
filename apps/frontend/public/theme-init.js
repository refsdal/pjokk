// Applies the theme BEFORE the first paint.
//
// AppearanceProvider and useNight own the theme once React is running, but
// both apply it from a useEffect — which runs after the first paint. That is
// two visible bugs:
//
//   1. Every cold start in dark or night mode flashed the LIGHT theme first.
//      In an app whose night mode exists so a parent at 3am gets near-black
//      and no blue light (CLAUDE.md §6), a face full of #faf9f7 on launch is
//      the one thing it must not do.
//   2. The `theme-color` meta stayed at its light default until hydration.
//      An installed PWA takes its status-bar colour from that, so on Android
//      in dark mode the system drew light glyphs over a near-white bar and
//      the clock and notification icons became unreadable. That is the bug
//      this file was written for.
//
// A SEPARATE FILE, not an inline <script>: the app is served under
// `script-src 'self'` with no 'unsafe-inline' and no hashes
// (internal/web/web.go). An inline bootstrap would work in `vite dev` and be
// silently blocked in the container — which is the worst way to find out.
//
// The logic below is deliberately duplicated from lib/appearance.tsx,
// lib/night.ts and lib/system-chrome.ts, because nothing from the bundle can
// run this early. Two tests keep the copy honest: test/contrast.test.ts
// asserts the colours still match styles.css, and test/theme-init.test.ts
// executes THIS FILE against a stub DOM and asserts it resolves the same
// colour lib/system-chrome.ts would.
(() => {
  try {
    const el = document.documentElement;

    let theme = localStorage.getItem("pjokk.theme.mode");
    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      theme = "system";
    }
    const dark =
      theme === "dark" ||
      (theme === "system" &&
        !!window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);

    let mode = localStorage.getItem("pjokk.night.mode");
    if (mode !== "on" && mode !== "off" && mode !== "auto") mode = "auto";

    let night;
    if (mode === "on") {
      night = true;
    } else if (mode === "off") {
      night = false;
    } else {
      let start = 22;
      let end = 7;
      try {
        const raw = localStorage.getItem("pjokk.night.schedule");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            typeof parsed.startHour === "number" &&
            typeof parsed.endHour === "number"
          ) {
            start = parsed.startHour;
            end = parsed.endHour;
          }
        }
      } catch (e) {
        // Malformed schedule: fall back to the default window.
      }
      const h = new Date().getHours();
      // The window wraps midnight whenever start > end (22:00-07:00 does).
      night = start > end ? h >= start || h < end : h >= start && h < end;
    }

    el.classList.toggle("dark", dark);
    el.classList.toggle("night", night);

    // An installed app never gets a light colour, whatever its theme: its
    // status-bar background is baked from the manifest and cannot follow, so
    // a light value here means light glyphs on that bar and an unreadable
    // clock. lib/system-chrome.ts carries the whole account.
    const standalone =
      !!window.matchMedia &&
      window.matchMedia(
        "(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)",
      ).matches;

    // Same mapping as systemChromeColor(); --color-bg per theme.
    const color = night
      ? "#171310"
      : dark || standalone
        ? "#171512"
        : "#faf9f7";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", color);
  } catch (e) {
    // Storage unavailable, or anything else: leave index.html's default in
    // place — dark, because that is the value an installed app's baked status
    // bar needs. This must never be the reason the app fails to start.
  }
})();
