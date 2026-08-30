import { getLanguage } from "./i18n";

// The legal pages left the SPA in the landing split (PR #17) and now live on
// the public apex, built by apps/landing. __SITE_URL__ is that apex's
// origin, injected at build time from the SITE_URL env var (see
// apps/server/src/env.ts and vite.config.ts's `define`) so a self-hoster who
// sets SITE_URL gets their own policies linked, not Refsdal Holding AS's.
//
// The landing site publishes each document in both languages, at "/privacy"
// (English) and "/nb/privacy" (Norwegian) — see apps/landing/src/page.ts —
// so this must stay in sync with getLanguage(), the same source the old
// in-app LegalPage seeded its language from.
export function legalUrl(doc: "privacy" | "terms"): string {
  const prefix = getLanguage() === "nb" ? "/nb" : "";
  return `${__SITE_URL__}${prefix}/${doc}`;
}
