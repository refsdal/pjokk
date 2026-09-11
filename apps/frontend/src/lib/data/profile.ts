import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_BASE, client, unwrap } from "../api";
import { useAppearance } from "../appearance";
import { getLanguageMode, resolveLanguage, type LanguageMode } from "../i18n";
import { planLanguageSync } from "../language-sync";
import { type Me, useMe } from "./family";
import { invalidateLogs } from "./keys";

// The caller's own profile (spec §4/§5). Every write returns the fresh Me,
// which replaces the cached one directly, and refreshes members (it shows
// this person's name and face); only a name/nickname change also touches
// every log view — see useProfileMutation below.

export interface UpdateMeVars {
  name?: string;
  nickname?: string | null;
  phone?: string | null;
  units?: "metric" | "imperial";
  languageMode?: LanguageMode;
  language?: "en" | "nb";
}

// Every mutation replaces the cached `me` and refreshes `members` (both show
// this person's face). Only a name/nickname change also invalidates every
// log view: `caretakerName` is derived from display_name, so it changes on
// every log a person has ever made — an avatar change touches no log row.
function useProfileMutation<V>(
  fn: (vars: V) => Promise<Me>,
  invalidatesLogs: boolean,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (me) => {
      qc.setQueryData(["me"], me);
      void qc.invalidateQueries({ queryKey: ["members"] });
      if (invalidatesLogs) invalidateLogs(qc);
    },
  });
}

export function useUpdateMe() {
  return useProfileMutation(
    (vars: UpdateMeVars) => unwrap<Me>(client.PATCH("/api/me", { body: vars })),
    true,
  );
}

// The language fields alone: no log row shows them, so no log view is
// invalidated.
export function useSaveLanguage() {
  return useProfileMutation(
    (vars: Pick<UpdateMeVars, "languageMode" | "language">) =>
      unwrap<Me>(client.PATCH("/api/me", { body: vars })),
    false,
  );
}

// Keeps this device and the person's stored language in step
// (lib/language-sync.ts). It runs when the SERVER's copy changes — a fresh
// me — and never because only the device's did, so a pick in Settings is
// not undone by the me it was made against; that pick saves itself
// (screens/settings/AppearanceSection.tsx). Mounted in the signed-in shell:
// sign-in screens and kiosk tablets have no person to follow.
export function useLanguageSync() {
  const me = useMe();
  const { setLanguage } = useAppearance();
  const { mutate } = useSaveLanguage();
  const serverMode = me.data?.languageMode;
  const serverLanguage = me.data?.language;
  useEffect(() => {
    if (serverMode === undefined || serverLanguage === undefined) return;
    const plan = planLanguageSync(
      { languageMode: serverMode, language: serverLanguage },
      getLanguageMode(),
      resolveLanguage,
    );
    if (plan.adopt) setLanguage(plan.adopt);
    if (plan.patch) mutate(plan.patch);
  }, [serverMode, serverLanguage, setLanguage, mutate]);
}

// Multipart and JPEG-streaming routes are outside the OpenAPI spec (see
// internal/api/avatar.go), so these two go through raw fetch like the
// vaccine-document upload does.
export function useUploadAvatar() {
  return useProfileMutation(async (file: Blob) => {
    const form = new FormData();
    form.append("file", file, "avatar.jpg");
    return unwrap<Me>(
      await fetch(`${API_BASE}/api/me/avatar`, {
        method: "PUT",
        body: form,
        credentials: "include",
      }),
    );
  }, false /* invalidatesLogs */);
}

export function useDeleteAvatar() {
  return useProfileMutation(
    async () =>
      unwrap<Me>(
        await fetch(`${API_BASE}/api/me/avatar`, {
          method: "DELETE",
          credentials: "include",
        }),
      ),
    false,
  );
}
