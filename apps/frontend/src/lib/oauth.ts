// Shared between Login and Join (#27): the button label for each configured
// OAuth provider id. `GET /api/config`'s `oauthProviders` array (see
// `lib/data/config.ts`'s `useConfig`) drives which buttons actually render —
// this map is only the label lookup, so Apple joins here without touching
// either screen's render loop. Values are the untranslated English key;
// render sites pass them through `t()`.
export const oauthProviderLabels: Record<string, string> = {
  google: "Continue with Google",
};
