import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_BASE, client, unwrap } from "../api";
import type { Me } from "./family";
import { invalidateLogs } from "./keys";

// The caller's own profile (spec §4/§5). Every write returns the fresh Me,
// which replaces the cached one directly, and refreshes members (it shows
// this person's name and face); only a name/nickname change also touches
// every log view — see useProfileMutation below.

export interface UpdateMeVars {
  name?: string;
  nickname?: string | null;
  phone?: string | null;
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
