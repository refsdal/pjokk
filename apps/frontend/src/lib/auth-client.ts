import { createAuthClient } from "limen-auth/react";
import {
  credentialPasswordPlugin,
  oauthClientPlugin,
  organizationPlugin,
} from "limen-auth/plugins";
import { API_BASE } from "./api";
import { resetCache } from "./query";

// Limen (Go) replaced better-auth here. Only a narrow slice of Limen's HTTP
// surface is mounted server-side (apps/server-go/internal/auth/auth.go's
// allowedRouteIDs): credential sign-in, Google authorize + callback, signout,
// GET /me, and organization create/list/switch. Everything else 404s, so this
// module deliberately exposes only the calls that map onto that allowlist.
//
// `baseURL: API_BASE` — '' means same origin, exactly as lib/api.ts does it;
// Limen's fetcher concatenates baseURL + path, so an empty base yields a
// relative URL the browser resolves against the page. A future native shell
// sets VITE_API_BASE and both clients follow.
export const authClient = createAuthClient({
  baseURL: API_BASE,
  basePath: "/api/auth",
  plugins: [
    credentialPasswordPlugin(),
    // signIn.social lives on the OAuth plugin, not the organization one —
    // REF §B5's snippet omits it, but without it there is no Google button.
    oauthClientPlugin(),
    organizationPlugin(),
  ],
});

// What the screens are allowed to see, deliberately narrow.
//
// Two traps in Limen's session payload, both confirmed against a running
// server rather than inferred from the SDK's types:
//
//  1. There is NO `id`. Limen's public-ID transform replaces the row id with
//     an opaque `public_id`, which is a DIFFERENT value from the user id our
//     own tables (and every /api/ route) key on. Reading it as "the user id"
//     would silently compare two unrelated uuids.
//  2. It carries no active organization at all, and its `name`/`role` columns
//     are Limen's copies rather than the values our handlers enforce on.
//
// So this exposes only "there is a session, and whose email it is". Identity,
// role, family and impersonation all come from GET /api/me (`useMe()` in
// lib/data/family.ts) — one request, server truth.
export interface SessionUser {
  email: string;
}

export interface Session {
  user: SessionUser;
}

/**
 * "Am I signed in?", nothing more. Shaped like the old better-auth hook
 * (`{ data, isPending }`) so the auth gates in the shells and the public
 * screens read the same, but the `session.session.*` half of the old shape is
 * gone: the fields those reads wanted (activeOrganizationId, impersonatedBy)
 * now come from `useMe()`.
 */
export function useSession(): { data: Session | null; isPending: boolean } {
  const state = authClient.useSession();
  // `settled` — not `isPending` — is the "data is known" flag. The store
  // starts settled:false / isPending:false and only flips to pending once
  // React mounts the subscription, so keying off isPending alone would make
  // the very first render look signed-out and bounce every gate to /login.
  // A failed load (network, 5xx) settles nothing, so treat an error as
  // "known, and signed out" rather than hanging on a blank screen forever.
  return {
    data: state.data,
    isPending: !state.settled && state.error === null,
  };
}

// Limen's redirect_uri must be an absolute URL whose origin matches the
// server's BaseURL — it runs through IsTrustedOrigin, which parses the value
// and compares scheme://host, so a bare "/home" is rejected with 403.
function absoluteUrl(path: string): string {
  return new URL(path, API_BASE || window.location.origin).toString();
}

export const signIn = {
  /**
   * Email + password. Limen calls the identifier a "credential" (it can be a
   * username on servers that enable one); ours is always the email address.
   * Throws on failure — Limen rejects rather than returning `{ error }`.
   */
  async password(email: string, password: string): Promise<void> {
    await authClient.signIn.credential({ credential: email, password });
    // A different account may have been signed in before; nothing of theirs
    // should survive into this session's caches.
    await resetCache();
  },

  /**
   * Google. Resolves the provider's authorization URL and navigates there;
   * the callback returns the browser to `redirectTo`. Clears the cache first
   * because the navigation leaves the page for good.
   */
  async google(redirectTo: string): Promise<void> {
    await resetCache();
    await authClient.signIn.social({
      provider: "google",
      redirectUri: absoluteUrl(redirectTo),
    });
  },
};

/**
 * Sign out, then drop every cached query. The offline cache is persisted to
 * IndexedDB and survives the reload that follows, so without this the next
 * visitor to this browser would be shown the previous account's family, name
 * and email until the network answered.
 */
export async function signOut(): Promise<void> {
  try {
    await authClient.signout();
  } finally {
    await resetCache();
  }
}
