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

export function useMembers() {
  return useQuery({
    queryKey: ["members"],
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
