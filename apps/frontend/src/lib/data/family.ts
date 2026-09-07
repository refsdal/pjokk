import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Baby, Family, Invite, Member } from "@pjokk/shared";
import type { components } from "../api-schema";
import { client, unwrap } from "../api";

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
