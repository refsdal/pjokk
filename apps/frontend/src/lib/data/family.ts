import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { Baby, Family, Feature, Invite, Member } from "@pjokk/shared";
import type { components } from "@pjokk/shared";
import { API_BASE, client, unwrap } from "../api";
import { toast } from "../toast";

// Who the caller is, according to the server. This replaces every read the
// screens used to take off the better-auth session object — the system-admin
// role (the old `isSysadmin(session)` cast), the active family
// (`session.session.activeOrganizationId`), the display name, and the
// impersonation banner's `impersonatedBy`. Limen's own session payload
// carries none of that: the Go server registers no user additional-fields
// schema, so /api/auth/me is id + email only. One request, server truth.
// `Me` has no `@pjokk/shared` counterpart (unlike Baby/Family/Invite/Member
// below) — it's a Go-only endpoint, so its type comes straight off the
// generated OpenAPI schema rather than being hand-maintained here.
export type Me = components["schemas"]["Me"];

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => unwrap<Me>(client.GET("/api/me")),
    // A 401 here means "signed out", which the auth gates already handle;
    // retrying it just delays the redirect to /login.
    retry: false,
    // me decides routing (which family is active, /welcome vs /home) and is
    // persisted across reloads. It must NOT be served stale: a founder who
    // just created a family would otherwise reload into the pre-family
    // snapshot (familyId null, still "fresh" under the global 15s staleTime)
    // and get bounced to /welcome. Always re-derive it from the server on
    // mount; the shell waits for that fetch before trusting familyId.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useFamily() {
  return useQuery({
    queryKey: ["family"],
    queryFn: async () => unwrap<Family>(client.GET("/api/family")),
  });
}

// Billing removed (self-hosted Pjokk has no plans): all features are free.
// Kept as a hook — rather than deleted and call sites rewritten — so the
// (now dead) entitlement call sites didn't need touching one by one.
export function usePremium(): boolean {
  return true;
}

export function useBabies() {
  return useQuery({
    queryKey: ["babies"],
    queryFn: async () => unwrap<Baby[]>(client.GET("/api/babies")),
  });
}

export type SetBabyFeaturesVars = { babyId: string; features: Feature[] };

// The per-baby tracking switches (lib/tracking.ts). Optimistic on the
// babies list, which is what every screen reads, so a card lights up at
// once; a flip made offline queues like a log and replays whole (the
// route replaces the set, so a replay is harmless).
export function registerFamilyMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["setBabyFeatures"], {
    mutationFn: async (vars: SetBabyFeaturesVars) =>
      unwrap<Baby>(
        client.PUT("/api/babies/{id}/features", {
          params: { path: { id: vars.babyId } },
          body: { features: vars.features },
        }),
      ),
    onMutate: async (vars: SetBabyFeaturesVars) => {
      await qc.cancelQueries({ queryKey: ["babies"] });
      const previous = qc.getQueryData<Baby[]>(["babies"]);
      qc.setQueryData<Baby[]>(["babies"], (old) =>
        old?.map((b) =>
          b.id === vars.babyId ? { ...b, features: vars.features } : b,
        ),
      );
      return { previous };
    },
    onError: (err: Error, _vars: SetBabyFeaturesVars, ctx: unknown) => {
      const snap = ctx as { previous?: Baby[] } | undefined;
      if (snap?.previous) qc.setQueryData(["babies"], snap.previous);
      toast(err.message, "error");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["babies"] });
    },
  });
}

export function useSetBabyFeatures() {
  return useMutation<Baby, Error, SetBabyFeaturesVars>({
    mutationKey: ["setBabyFeatures"],
  });
}

// A baby's photo (internal/api/baby_avatar.go): multipart in and a Baby
// out, outside the spec like a person's, so raw fetch. The fresh list is
// what every face reads from, so the write just refreshes it.
function useBabyAvatarMutation<V>(fn: (vars: V) => Promise<Baby>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["babies"] });
    },
  });
}

export function useUploadBabyAvatar(babyId: string) {
  return useBabyAvatarMutation(async (file: Blob) => {
    const form = new FormData();
    form.append("file", file, "baby.jpg");
    return unwrap<Baby>(
      await fetch(`${API_BASE}/api/babies/${babyId}/avatar`, {
        method: "PUT",
        body: form,
        credentials: "include",
      }),
    );
  });
}

export function useDeleteBabyAvatar(babyId: string) {
  return useBabyAvatarMutation(async () =>
    unwrap<Baby>(
      await fetch(`${API_BASE}/api/babies/${babyId}/avatar`, {
        method: "DELETE",
        credentials: "include",
      }),
    ),
  );
}

// babyId → avatarUrl, useMemberAvatars' twin: a calendar event names its
// babies by id and name only.
export function useBabyAvatars(): Record<string, string | null> {
  const babies = useBabies();
  return useMemo(
    () =>
      Object.fromEntries(
        (babies.data ?? []).map((b) => [b.id, b.avatarUrl] as const),
      ),
    [babies.data],
  );
}

export function useMembers(enabled = true) {
  return useQuery({
    queryKey: ["members"],
    enabled,
    queryFn: async () => unwrap<Member[]>(client.GET("/api/family/members")),
  });
}

export function useInvites(enabled: boolean) {
  return useQuery({
    queryKey: ["invites"],
    enabled,
    queryFn: async () => unwrap<Invite[]>(client.GET("/api/invites")),
  });
}

// userId → avatarUrl for the active family's members. Log entries and
// calendar assignees carry only a user id, so rows look their face up here;
// a missing entry (an ex-member, or members not loaded yet) renders as the
// initial. The timeline stays offline-viewable because it never WAITS on
// this query.
export function useMemberAvatars(): Record<string, string | null> {
  const members = useMembers();
  return useMemo(
    () =>
      Object.fromEntries(
        (members.data ?? []).map((m) => [m.userId, m.avatarUrl] as const),
      ),
    [members.data],
  );
}
