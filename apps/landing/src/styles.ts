// Inline stylesheet for the public landing page.
//
// The colour tokens are copied from apps/frontend/src/styles.css on purpose. The landing
// page is served by the Worker as a standalone document and never loads the
// app's Tailwind build, so it cannot share them. That duplication is the price
// of a marketing page that costs a stranger one request and no JavaScript;
// keep the two lists in step if the palette ever moves.

export const LANDING_CSS = `
:root {
  --bg: #faf9f7;
  --surface: #ffffff;
  --surface-2: #f3f1ed;
  --ink: #29261f;
  --ink-soft: #524d43;
  --muted: #6e6759;
  --line: #e9e6e0;
  /* Brand tokens, deliberately identical to the SPA's (apps/frontend/
     src/styles.css) — the two are one brand and a test asserts they match.
     Several were tuned by eye against white and sat under the 3:1 WCAG floor
     for meaningful graphics; deepened the minimum amount to reach it. */
  --accent: #d87657;
  --accent-soft: #f7e9e2;
  --on-accent: #ffffff;
  --sleep: #8b7bd8;
  --feed: #5795cf;
  --diaper: #37a095;
  --growth: #cc7c5b;
  --bezel: #29261f;
  --shadow: 0 24px 60px -24px rgba(41, 38, 31, .32);
  --cycle: 12s;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171512;
    --surface: #1f1d19;
    --surface-2: #2a2723;
    --ink: #ece8e1;
    --ink-soft: #b6afa3;
    --muted: #8b8578;
    --line: #2e2b26;
    --accent: #e08a68;
    --accent-soft: #3a2a21;
    /* Dark mode never overrode --on-accent, so the light theme's white
       leaked onto the accent: #ffffff on #e08a68 is 2.62:1 — on the primary
       call to action, on the public front door. */
    --on-accent: #171512;
    --sleep: #a294e6;
    --feed: #7fb3e8;
    --diaper: #56c6b9;
    --growth: #efa07e;
    --bezel: #0d0c0a;
    --shadow: 0 24px 60px -24px rgba(0, 0, 0, .6);
  }
}

*, *::before, *::after { box-sizing: border-box; }

html {
  -webkit-text-size-adjust: 100%;
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 17px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: 4px;
}

.skip {
  position: absolute;
  left: -9999px;
}
.skip:focus {
  left: 1rem;
  top: 1rem;
  z-index: 10;
  background: var(--surface);
  color: var(--ink);
  padding: .6rem 1rem;
  border-radius: 999px;
  box-shadow: var(--shadow);
}

.wrap {
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding-inline: max(20px, env(safe-area-inset-left), env(safe-area-inset-right));
}

/* ---------- header ---------- */

.site-header {
  padding-block: 20px;
  padding-top: max(20px, env(safe-area-inset-top));
}
.site-header > .wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: auto;
  text-decoration: none;
  font-weight: 800;
  font-size: 1.15rem;
  letter-spacing: -.01em;
}
.brand img { width: 34px; height: 34px; display: block; }

.lang {
  display: inline-flex;
  align-items: center;
  height: 44px;
  padding-inline: 14px;
  border-radius: 999px;
  color: var(--muted);
  font-size: .9rem;
  font-weight: 700;
  text-decoration: none;
}
.lang:hover { background: var(--surface-2); color: var(--ink); }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding-inline: 26px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
  font-size: 1rem;
  text-decoration: none;
  border: 0;
  transition: transform .12s ease, filter .12s ease;
}
.btn:hover { filter: brightness(1.05); }
.btn:active { transform: scale(.97); }
.btn--sm { min-height: 44px; padding-inline: 20px; font-size: .95rem; }

/* ---------- hero ---------- */

.hero {
  display: grid;
  gap: 48px;
  align-items: center;
  padding-block: 32px 72px;
}
@media (min-width: 900px) {
  .hero {
    grid-template-columns: 1.05fr .95fr;
    gap: 64px;
    padding-block: 56px 104px;
  }
}

h1 {
  margin: 0;
  font-size: clamp(2.3rem, 7vw, 3.7rem);
  font-weight: 800;
  line-height: 1.03;
  letter-spacing: -.03em;
  text-wrap: balance;
}

.lead {
  margin: 20px 0 0;
  font-size: clamp(1.05rem, 2.4vw, 1.2rem);
  color: var(--ink-soft);
  max-width: 32em;
  text-wrap: pretty;
}

.hero-actions {
  margin-top: 32px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}

.free-line {
  margin: 0;
  color: var(--muted);
  font-size: .95rem;
  font-weight: 600;
}

.invite-line {
  margin: 22px 0 0;
  color: var(--muted);
  font-size: .92rem;
  max-width: 30em;
}

/* ---------- phone mock-up ---------- */

.demo-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.demo {
  position: relative;
  width: 100%;
  max-width: 296px;
  aspect-ratio: 9 / 18.5;
  border: 9px solid var(--bezel);
  border-radius: 42px;
  background: var(--bg);
  box-shadow: var(--shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 14px 12px 0;
  font-size: 12px;
  user-select: none;
}

.demo-caption {
  margin: 0;
  color: var(--muted);
  font-size: .85rem;
  text-align: center;
  max-width: 24em;
}

.demo-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 12px;
}
.demo-avatar {
  width: 30px; height: 30px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 13px;
}
.demo-name { font-weight: 800; font-size: 13px; line-height: 1.1; }
.demo-age { color: var(--muted); font-size: 11px; }

.demo-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 9px 11px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--line);
}
.demo-dot {
  width: 8px; height: 8px;
  border-radius: 999px;
  background: var(--sleep);
  animation: pulse 2.4s ease-in-out infinite;
}
.demo-banner-label { font-weight: 700; color: var(--sleep); }
.demo-banner-time { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }

.demo-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.demo-card {
  padding: 10px 11px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--line);
}
.demo-card-label { color: var(--muted); font-size: 10.5px; font-weight: 600; }
.demo-card-value {
  display: grid;
  font-weight: 800;
  font-size: 13px;
  margin-top: 2px;
}
/* Both readings occupy the same cell so one can cross-fade into the other. */
.demo-card-value > span { grid-area: 1 / 1; }

.demo-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
}
.demo-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  aspect-ratio: 1 / .82;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-weight: 700;
  font-size: 11.5px;
}
.demo-btn svg { width: 21px; height: 21px; }
.i-feed { color: var(--feed); }
.i-diaper { color: var(--diaper); }
.i-sleep { color: var(--sleep); }
.i-more { color: var(--muted); }

.demo-tabbar {
  margin-top: auto;
  display: flex;
  justify-content: space-around;
  padding: 9px 0 12px;
  border-top: 1px solid var(--line);
  margin-inline: -12px;
  background: var(--surface);
}
.demo-tabbar span {
  width: 20px; height: 3px;
  border-radius: 999px;
  background: var(--line);
}
.demo-tabbar span:first-child { background: var(--accent); }

/* The log sheet, sliding over the screen the way vaul does in the app. */
.demo-sheet {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  padding: 14px 14px 18px;
  border-radius: 20px 20px 0 0;
  background: var(--surface-2);
  border-top: 1px solid var(--line);
  transform: translateY(103%);
}
.demo-sheet-grip {
  width: 34px; height: 4px;
  border-radius: 999px;
  background: var(--line);
  margin: 0 auto 12px;
}
.demo-sheet-title { font-weight: 800; font-size: 13px; }
.demo-sheet-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.demo-pill {
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-weight: 700;
  font-size: 12px;
}
.demo-pill--on {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.demo-save {
  margin-top: 12px;
  padding: 10px;
  border-radius: 14px;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 800;
  font-size: 13px;
  text-align: center;
}

/* ---------- the loop ---------- */

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
@keyframes tapFeed {
  0%, 23% { transform: none; background: var(--surface); border-color: var(--line); }
  26%, 29% { transform: scale(.95); background: var(--accent-soft); border-color: var(--accent); }
  33%, 100% { transform: none; background: var(--surface); border-color: var(--line); }
}
@keyframes sheetUp {
  0%, 27% { transform: translateY(103%); }
  34%, 57% { transform: translateY(0); }
  65%, 100% { transform: translateY(103%); }
}
@keyframes tapSave {
  0%, 52% { transform: none; filter: none; }
  55%, 58% { transform: scale(.97); filter: brightness(.88); }
  62%, 100% { transform: none; filter: none; }
}
@keyframes agoOut {
  0%, 60% { opacity: 1; }
  65%, 93% { opacity: 0; }
  100% { opacity: 1; }
}
@keyframes agoIn {
  0%, 60% { opacity: 0; }
  65%, 93% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes cardFlash {
  0%, 61% { background: var(--surface); }
  66% { background: var(--accent-soft); }
  80%, 100% { background: var(--surface); }
}

.demo-btn--feed { animation: tapFeed var(--cycle) ease-in-out infinite; }
.demo-sheet { animation: sheetUp var(--cycle) cubic-bezier(.32, .72, 0, 1) infinite; }
.demo-save { animation: tapSave var(--cycle) ease-in-out infinite; }
.demo-ago--old { animation: agoOut var(--cycle) ease-in-out infinite; }
.demo-ago--new { animation: agoIn var(--cycle) ease-in-out infinite; }
.demo-card--feed { animation: cardFlash var(--cycle) ease-in-out infinite; }

/* Reduced motion: hold the mock-up in its resting state rather than animate
   it. The page still shows what the app looks like — it just stops moving. */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .demo *, .demo { animation: none !important; }
  .demo-sheet { display: none; }
  .demo-ago--new { opacity: 0; }
}

/* ---------- points ---------- */

.section { padding-block: 56px; }
.section h2 {
  margin: 0 0 28px;
  font-size: clamp(1.5rem, 3.4vw, 2rem);
  font-weight: 800;
  letter-spacing: -.02em;
}

.points {
  display: grid;
  gap: 28px;
}
@media (min-width: 760px) {
  .points { grid-template-columns: repeat(3, 1fr); gap: 36px; }
}
.point h3 {
  margin: 0 0 8px;
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: -.01em;
}
.point p { margin: 0; color: var(--ink-soft); font-size: .98rem; }
.point-mark {
  width: 34px; height: 34px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  margin-bottom: 14px;
  background: var(--surface-2);
}
.point-mark svg { width: 19px; height: 19px; }
.point:nth-child(1) .point-mark { color: var(--feed); }
.point:nth-child(2) .point-mark { color: var(--diaper); }
.point:nth-child(3) .point-mark { color: var(--sleep); }

/* ---------- privacy band ---------- */

.band {
  margin-block: 16px 72px;
  padding: 32px;
  border-radius: 24px;
  background: var(--surface-2);
}
@media (min-width: 760px) {
  .band { padding: 44px 48px; }
}
.band h2 {
  margin: 0 0 12px;
  font-size: clamp(1.35rem, 3vw, 1.7rem);
  font-weight: 800;
  letter-spacing: -.02em;
}
.band p {
  margin: 0;
  color: var(--ink-soft);
  max-width: 46em;
}

/* ---------- founder story ---------- */

/* Deliberately plainer than .band directly above it: two heavy tinted
   blocks in a row would fight, and this one should read as someone
   talking rather than as another feature panel. */
.story {
  padding-block: 0 80px;
}
.story h2 {
  margin-bottom: 16px;
}
.story p {
  margin: 0 0 1em;
  max-width: 34em;
  color: var(--ink-soft);
  text-wrap: pretty;
}
.story .signature {
  margin: 24px 0 0;
  color: var(--muted);
  font-size: .92rem;
  font-weight: 700;
}

/* ---------- legal pages ---------- */

/* The bodies here are prerendered from the SPA's own React components
   (renderToStaticMarkup — see legal.tsx), so they still carry the Tailwind
   utility class names those components were written with (text-sm, text-ink,
   list-disc, …). This package has no Tailwind build, so those class names are
   inert; style by element instead, scoped to .legal so nothing here leaks
   into the marketing page above. */

.legal {
  max-width: 640px;
  padding-block: 40px 96px;
}
.legal h1 {
  margin: 0 0 4px;
  font-size: clamp(1.7rem, 5vw, 2.2rem);
  font-weight: 800;
  letter-spacing: -.02em;
}
.legal h2 {
  margin: 28px 0 8px;
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: -.01em;
}
.legal p {
  margin: 0 0 1em;
  color: var(--ink-soft);
}
.legal-updated {
  margin: 0 0 24px;
  font-size: .88rem;
  color: var(--muted);
}
.legal ul {
  margin: 0 0 1em;
  padding-left: 1.25em;
  color: var(--ink-soft);
}
.legal ul li {
  margin-bottom: .4em;
}
/* ControllerCard's own utility classes, reproduced as plain rules. */
.legal .text-sm {
  font-size: .88rem;
}
.legal .text-muted {
  color: var(--muted);
}
.legal .font-semibold {
  font-weight: 700;
}
.legal .text-accent {
  color: var(--accent);
}
.legal a {
  text-decoration: underline;
}

/* ---------- footer ---------- */

.site-footer {
  border-top: 1px solid var(--line);
  padding-block: 28px;
  padding-bottom: max(28px, env(safe-area-inset-bottom));
  color: var(--muted);
  font-size: .88rem;
}
.site-footer > .wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
}
.site-footer a { font-weight: 700; text-decoration: none; }
.site-footer a:hover { color: var(--ink); text-decoration: underline; }
.site-footer .spacer { margin-left: auto; }
`;
