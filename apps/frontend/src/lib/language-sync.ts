import type { LanguageMode } from "./i18n";

// The app's language is the PERSON's (DECISIONS 2026-09-11): the choice in
// Settings is stored on the server and every device they sign in on
// follows it; "auto" still resolves per device, and the server keeps what
// the app last resolved it to, because push notifications are written in
// that. This is the pure decision; the effect that runs it is
// useLanguageSync in lib/data/profile.ts.

export interface ServerLanguage {
  /** The stored choice; null until an app has sent one. */
  languageMode: LanguageMode | null;
  /** The language pushes are written in. */
  language: "en" | "nb";
}

export interface LanguageSyncPlan {
  /** Switch this device to the person's choice. */
  adopt?: LanguageMode;
  /** Tell the server. */
  patch?: { languageMode?: LanguageMode; language?: "en" | "nb" };
}

export function planLanguageSync(
  server: ServerLanguage,
  deviceMode: LanguageMode,
  resolve: (m: LanguageMode) => "en" | "nb",
): LanguageSyncPlan {
  // First app to meet this person since the choice moved to the server:
  // their device-local choice becomes the stored one, rather than the
  // server's default overwriting it.
  if (server.languageMode === null) {
    return {
      patch: { languageMode: deviceMode, language: resolve(deviceMode) },
    };
  }
  const plan: LanguageSyncPlan = {};
  if (server.languageMode !== deviceMode) plan.adopt = server.languageMode;
  const resolved = resolve(server.languageMode);
  if (resolved !== server.language) plan.patch = { language: resolved };
  return plan;
}
