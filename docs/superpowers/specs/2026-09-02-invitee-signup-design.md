# Invitee signup & signup UI — Design

**Date:** 2026-09-02
**Status:** Approved design, pending implementation plan
**Issues:** #26 (invitee signup under closed signup), #27 (signup UI / config probe)

## Problem

The Go auth hardening closed account creation on every path when
`OPEN_SIGNUP=0` (the production state): credential signup is disabled, and
Google-initiated signup is refused (`oauth.WithRequireExplicitSignUp()`). But
`POST /api/invites/redeem` requires an existing session. So:

- **#26:** a brand-new invitee has no way to create the account they need to
  redeem their invite. `/join/CODE` only works for people who already have
  accounts. CLAUDE.md's stated design ("accounts can only be created through
  the invite-code redeem flow") has no working flow behind it.
- **#27:** the SPA has no signup UI. The README's `OPEN_SIGNUP=1` bootstrap
  ("create an account through the UI") only works via Google; a self-hoster
  without Google configured must `curl` the signup endpoint. The SPA also
  shows a Google button even when Google is not configured (a dead button).

## Feasibility constraint (why this design, not another)

Limen's pinned OAuth plugin gates account creation with a **static config
flag** (`requireExplicitSignUp`, checked in `account_linker.go`), with **no
hook and no per-request override**. There is no clean way to say "allow this
OAuth signup because a valid invite is present." Per-invite OAuth signup
gating is therefore not achievable without either forking Limen's callback or
reopening OAuth signup globally.

## Key insight

An uninvited account can do exactly two things: redeem an invite (needs a
code — fine) or **create a family** (`allowOrgCreation`, today allowed for any
family-less user). **Family creation is the only abuse vector.** Guard *that*,
not account existence, and an uninvited account becomes inert — and the
existing orphan-purge cron (`purgeOrphanUsers`: deletes memberless, non-admin
users older than 7 days) removes it automatically. No fragile hot-path
cleanup is needed.

The closed-alpha guarantee shifts from "no accounts without an invite" to
"**no access (families, data) without an invite**" — weaker on paper,
identical against abuse, and self-cleaning.

## Design

### 1. Server auth model (the security core)

**Open OAuth account creation for configured providers.** Run the OAuth
plugin WITHOUT `requireExplicitSignUp`, regardless of `OPEN_SIGNUP`. This is
provider-agnostic: it applies to whichever OAuth plugins are registered
(Google today; GitHub/Microsoft/Apple later). Credential signup stays gated
by `OPEN_SIGNUP` exactly as now (`WithHTTPDisabledPaths("signup")` when
closed). So under closed signup, OAuth is the only account-creation path, and
an invitee can use any configured provider.

**Tighten `allowOrgCreation`** from `sysadmin OR family-less` to:

```
sysadmin OR (family-less AND OpenSignup)
```

Today's rule is safe only because closed signup makes family-less accounts
unobtainable; opening OAuth signup obtains them, so family creation must
require the founder-bootstrap window (`OPEN_SIGNUP=1`) or system-admin. This
gate already fires on BOTH creation entry points (the package's own
`CreateFamily` and Limen's `POST /organizations`), so it cannot be bypassed.
Fails CLOSED on error, as now. `allowOrgCreation` gains access to the
`OpenSignup` config value (passed into `New`, captured in the closure).

**Result under closed signup:** an uninvited OAuth account is family-less,
`OPEN_SIGNUP` is off → cannot create a family, cannot join without a code →
inert → purged after 7 days by the existing cron. No new cleanup code.

### 2. `/api/config` (new, unauthenticated)

`GET /api/config → { openSignup: bool, oauthProviders: string[] }`

- `openSignup`: mirrors the config flag.
- `oauthProviders`: the ids of the OAuth providers actually configured/
  registered (`["google"]` when `GOOGLE_CLIENT_ID`/`SECRET` are set; `[]`
  otherwise). The SPA renders one button per id and never shows a dead one.

No secrets. Registered in the `tierPublic` allowlist AND the
`tierPublicAPIAllowlist` boot-assertion set (alongside `GetInviteInfo`), so it
is reachable without a session and the assertion does not panic. Served via
the strict server like other JSON routes.

### 3. Frontend

**`lib/auth-client.ts`** exposes a generic `signIn.social(provider, redirect)`
wrapping limen-auth's `signIn.social({ provider, ... })`. The existing
`signIn.google` becomes a thin alias or is replaced at call sites.

**`lib/data`** gains a `useConfig()` query hitting `GET /api/config`
(identity-adjacent but public and static; a normal cached query is fine — it
is not routing-critical the way `me` is).

**Login screen (#27):**
- Render one OAuth button per `oauthProviders` entry, via a small `{id →
  label}` map (`google → "Continue with Google"`). Zero buttons when the list
  is empty.
- Show a credential **"Create account"** form only when `openSignup`. It
  calls the (already-enabled-under-`OPEN_SIGNUP`) `POST
  /api/auth/signup/credential`, then signs in. This is the bootstrap UI.
- Credential **sign-in** stays as today.

**Join screen (#26):**
- For a signed-out visitor, render the same per-provider OAuth buttons, each
  carrying the `/join/CODE` redirect in OAuth state (already works).
- On returning signed-in with the code in the URL, **auto-redeem** — call the
  existing session-based `POST /api/invites/redeem` without a second click,
  then land on `/home`. (Today the visitor must click Join after returning.)

**Welcome screen:** a family-less non-sysadmin under closed signup can no
longer create a family, so show the "you need an invite" state rather than a
create-family form that would 403. The founder (sysadmin, or during
`OPEN_SIGNUP`) still sees the create form.

### What is deliberately NOT built (YAGNI)

- **No `redeem-new` credential endpoint.** With OAuth-for-invitees, there is
  no email/password invitee path. `#26`'s server side reduces to the two
  Section-1 changes. Credential accounts exist only via the `OPEN_SIGNUP`
  bootstrap (the founder).
- **No signup-source marker column, no hot-path account cleanup.** The
  org-creation guard plus the existing purge cover it.
- **No Limen fork or per-request OAuth gating.**

## Testing

**Go:**
- `/api/config`: `oauthProviders` reflects configured plugins (Google set →
  `["google"]`; unset → `[]`); `openSignup` mirrors config; reachable without
  a session; boot assertion passes.
- `allowOrgCreation` matrix (the security-critical test): sysadmin → allow;
  family-less + `OpenSignup` → allow; family-less + closed → deny; existing
  member → deny. Assert via both `CreateFamily` and the HTTP
  `POST /organizations` path.
- Existing `purgeOrphanUsers` test already covers inert-account cleanup;
  no new purge test needed.

**E2E (Playwright):**
- Real OAuth can't run in CI, so the account-creation half of a brand-new
  invitee is driven via the API (as fixtures already do), then the Join
  screen's auto-redeem is exercised: fresh account (no family) opens
  `/join/CODE` → auto-redeems → `/home`, family visible.
- Login screen: the "Create account" form appears under `OPEN_SIGNUP=1`
  (the e2e stack already runs with it) and is absent when closed. Since the
  e2e stack runs open, assert the form is present and creates a working
  account; a closed-signup absence check can be a focused Go/api test on
  `/api/config` instead of a second stack.

## Files

**Server:** `internal/api/config.go` (new) + `openapi/pjokk.yaml` +
`operationAuthTiers`/`tierPublicAPIAllowlist` wiring; `internal/auth/auth.go`
(open OAuth signup, tightened `allowOrgCreation` with `OpenSignup`, expose
configured provider ids); a query/config accessor for the provider list.

**Frontend:** `lib/auth-client.ts` (generic social), `lib/data/*` (config
query), `screens/Login.tsx`, `screens/Join.tsx`, `screens/Welcome.tsx`.

**Docs:** README bootstrap note (signup UI now exists; OAuth-for-invitees);
CLAUDE.md auth section (closed-alpha guarantee reworded to "no access without
an invite"); DECISIONS.md entry.

## Residual risks (accepted)

- Inert OAuth accounts exist transiently before the 7-day purge — no access,
  no families, no data, no abuse surface.
- The closed-alpha guarantee is "no access without an invite," not "no
  accounts." Deliberate, per the key insight.
