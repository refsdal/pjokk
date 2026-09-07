// SITE_URL (see apps/server/src/env.ts) is injected at build time via Vite's
// `define` in vite.config.ts, not read from import.meta.env, so it is a
// plain global rather than a VITE_-prefixed env var.
declare const __SITE_URL__: string;
// The build version, same source as the server's (see vite.config.ts).
declare const __PJOKK_VERSION__: string;
