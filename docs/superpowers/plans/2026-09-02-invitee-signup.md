# Invitee Signup & Signup UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a brand-new invitee create an account and join a family under closed signup via any configured OAuth provider (#26), and give the SPA a real signup UI plus provider-aware buttons driven by a public `/api/config` probe (#27).

**Architecture:** Open OAuth account creation for configured providers, and make it safe by guarding the only abuse vector — family creation — with `allowOrgCreation = sysadmin OR (family-less AND OpenSignup)`; uninvited accounts become inert and the existing orphan-purge cron cleans them. A new unauthenticated `/api/config` exposes `{openSignup, oauthProviders}` so the SPA renders the right auth buttons and the bootstrap signup form.

**Tech Stack:** Go 1.27 (stdlib net/http + oapi-codegen strict server, Limen auth, pgx/sqlc), React/Vite SPA (openapi-fetch, limen-auth client, TanStack Query), Playwright E2E.

**Spec:** docs/superpowers/specs/2026-09-02-invitee-signup-design.md

## Global Constraints

- Toolchain via mise: `export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH` in every shell running go/sqlc; or use `mise x -- <cmd>`. sqlc/oapi-codegen are pinned in `.mise.toml`.
- Go tests run against real Postgres, `-p 1`: test DB at `postgres://pjokk:pjokk@127.0.0.1:55432/pjokk_test` (`docker compose -f docker-compose.test.yml up -d`).
- Spec-first: after editing `openapi/pjokk.yaml`, run `cd apps/server && go generate ./...` and commit the generated output; a drift-guard test enforces the embedded copy matches.
- Every generated operationId MUST have an entry in `operationAuthTiers` (`apps/server/internal/api/api.go`) or the handler build panics at boot. A `tierPublic` operation whose path starts with `/api/` MUST also be in `tierPublicAPIAllowlist` or the boot assertion panics.
- Error envelope on every API error: `{"error": string, "code": string}`.
- The closed-alpha guarantee is now "no ACCESS without an invite" — an uninvited OAuth account may exist but must be unable to create a family or reach any family-scoped route. Never weaken the family-creation guard.
- `allowOrgCreation` fails CLOSED (returns false) on any query error.
- Frontend: `bun run typecheck`, `bun test apps/frontend`, `bun run check` must stay green. TanStack Query keys and component props stay stable where not intentionally changed.
- Conventional Commits; every commit compiles and its tests pass. Footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `invitee-signup` (already created; the spec is committed on it). Do NOT open the PR until the plan's final task.

---

### Task 1: Open OAuth signup + guard family creation (security core)

**Files:**
- Modify: `apps/server/internal/auth/auth.go` (remove the closed-signup `WithRequireExplicitSignUp` gate; add `OpenSignup` to the `allowOrgCreation` signature + its closure call site)
- Test: `apps/server/internal/auth/auth_test.go`

**Interfaces:**
- Produces: `allowOrgCreation(ctx context.Context, q *gen.Queries, userID string, openSignup bool) bool` — sysadmin → true; else `family-less AND openSignup`. (Was `(ctx, q, userID) bool`.)
- Behavioral change: an unknown OAuth (Google) identity now creates an account regardless of `OpenSignup` (the `oauth.WithRequireExplicitSignUp()` block is removed).

- [ ] **Step 1: Write the failing test** — add to `auth_test.go`. `newFixture(t, openSignup)` already exists; `signIn`, `CreateFamily`, `AddMember`, `promote` (sysadmin) helpers exist.

```go
// allowOrgCreation is the closed-alpha family-creation guard. With OAuth
// signup now open, a family-less non-admin may only create a family during
// the OPEN_SIGNUP founder-bootstrap window — never under closed signup,
// where an uninvited OAuth account would otherwise mint itself a free family.
func TestOrgCreationGuardMatrix(t *testing.T) {
	// Closed signup: a family-less non-admin CANNOT create a family.
	closed := newFixture(t, false)
	lonerID, _ := closed.signIn("Loner", "loner@example.com")
	if _, err := closed.svc.CreateFamily(closed.ctx, lonerID, "Nope"); err == nil {
		t.Fatal("closed signup: family-less non-admin created a family, want refusal")
	}

	// Closed signup: a system admin still can (the founder is sysadmin).
	adminID, _ := closed.signIn("Admin", "admin@example.com")
	closed.promote(adminID)
	if _, err := closed.svc.CreateFamily(closed.ctx, adminID, "Admin Fam"); err != nil {
		t.Fatalf("closed signup: sysadmin CreateFamily: %v", err)
	}

	// Open signup: a family-less non-admin CAN (the bootstrap window).
	open := newFixture(t, true)
	founderID, _ := open.signIn("Founder", "founder@example.com")
	if _, err := open.svc.CreateFamily(open.ctx, founderID, "Founder Fam"); err != nil {
		t.Fatalf("open signup: family-less CreateFamily: %v", err)
	}

	// Open signup: a user who ALREADY has a family cannot create a second.
	if _, err := open.svc.CreateFamily(open.ctx, founderID, "Second"); err == nil {
		t.Fatal("open signup: existing member created a second family, want refusal")
	}
}
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/server && go test -run TestOrgCreationGuardMatrix ./internal/auth/`. Expected: FAIL (closed-signup family-less currently allowed).

- [ ] **Step 3: Implement.** In `auth.go`:
  (a) Change `func allowOrgCreation(ctx context.Context, q *gen.Queries, userID string) bool` to take `openSignup bool` and return `memberships == 0 && openSignup` in the non-admin branch:
```go
func allowOrgCreation(ctx context.Context, q *gen.Queries, userID string, openSignup bool) bool {
	role, err := q.GetUserRole(ctx, userID)
	if err != nil {
		return false
	}
	if role == RoleSystemAdmin {
		return true
	}
	memberships, err := q.CountMembershipsForUser(ctx, userID)
	if err != nil {
		return false
	}
	// A family-less non-admin may self-create ONLY during the OPEN_SIGNUP
	// founder-bootstrap window. Under closed signup an uninvited OAuth
	// account is family-less too, and must not be able to mint a free family
	// — it stays inert and the orphan purge removes it.
	return memberships == 0 && openSignup
}
```
  (b) Update the `WithAllowOrgCreation` closure in `New` (~line 253) to pass `cfg.OpenSignup`:
```go
organization.WithAllowOrgCreation(func(ctx context.Context, user *limen.User) bool {
	return allowOrgCreation(ctx, authQueries, idString(user.ID), cfg.OpenSignup)
}),
```
  (c) Delete the `if !cfg.OpenSignup { opts = append(opts, oauth.WithRequireExplicitSignUp()) }` block (~line 348-355) and replace with a comment:
```go
// OAuth account creation is intentionally OPEN even under closed signup:
// it is the only way a brand-new invitee can get the account they need to
// redeem an invite (Limen has no per-invite signup gate). Safe because an
// uninvited OAuth account cannot create a family (allowOrgCreation requires
// OPEN_SIGNUP or sysadmin) or reach any family route, and the orphan purge
// removes it after 7 days. Credential signup stays gated by OPEN_SIGNUP
// (WithHTTPDisabledPaths above).
```

- [ ] **Step 4: Run to verify it passes** — `go test -p 1 -count=1 ./internal/auth/`. Also run `./internal/api/` (some tenancy/household tests may assert the old family-less-create behavior — if any fail, they were asserting the pre-guard rule; update them to the new rule the same way, and note it in the commit). Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(auth): open OAuth signup, guard family creation to OPEN_SIGNUP-or-sysadmin"` (+ footer).

---

### Task 2: `/api/config` endpoint + composition wiring

**Files:**
- Modify: `openapi/pjokk.yaml` (add `GET /api/config`), then `cd apps/server && go generate ./...`
- Create: `apps/server/internal/api/config.go`
- Modify: `apps/server/internal/api/api.go` (Deps fields `OpenSignup`, `OAuthProviders`; `operationAuthTiers["GetConfig"]=tierPublic`; add `"GetConfig"` to `tierPublicAPIAllowlist`)
- Modify: `apps/server/cmd/pjokk/main.go` (populate the two new Deps fields from config)
- Test: `apps/server/internal/api/config_test.go`

**Interfaces:**
- Consumes: `api.Deps` (existing struct in `api.go`).
- Produces: `GET /api/config → 200 {"openSignup": bool, "oauthProviders": []string}`, unauthenticated. `api.Deps.OpenSignup bool` and `api.Deps.OAuthProviders []string`.

- [ ] **Step 1: Spec.** In `openapi/pjokk.yaml` add under `paths:`:
```yaml
  /api/config:
    get:
      operationId: GetConfig
      summary: Public client configuration (no auth)
      responses:
        "200":
          description: Which account-creation paths the client should offer
          content:
            application/json:
              schema:
                type: object
                required: [openSignup, oauthProviders]
                properties:
                  openSignup: { type: boolean }
                  oauthProviders:
                    type: array
                    items: { type: string }
```

- [ ] **Step 2: Generate + write the failing test.** `cd apps/server && go generate ./...` (regenerates the strict server + embedded copy). Then `config_test.go`:
```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

func TestConfigIsPublicAndReflectsDeps(t *testing.T) {
	a := testrig.App(t) // default rig: OpenSignup false, no OAuth providers
	res := a.Do(http.MethodGet, "/api/config", "", nil) // no cookie
	if res.Status != http.StatusOK {
		t.Fatalf("GET /api/config status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["openSignup"] != false {
		t.Errorf("openSignup = %v, want false", res.JSON["openSignup"])
	}
	provs, ok := res.JSON["oauthProviders"].([]any)
	if !ok || len(provs) != 0 {
		t.Errorf("oauthProviders = %v, want []", res.JSON["oauthProviders"])
	}
}
```
Note: `testrig.App` builds `api.Deps` — it must set `OpenSignup:false, OAuthProviders:nil`. If the rig needs a knob to flip them, add optional fields to the rig in Task 5's frontend-independent way; for THIS test the defaults suffice. If `testrig` doesn't compile against the new Deps fields, add them as zero-value defaults there.

- [ ] **Step 3: Run to verify it fails** — `go test -run TestConfigIsPublicAndReflectsDeps ./internal/api/`. Expected: FAIL (route/handler absent).

- [ ] **Step 4: Implement.**
  (a) `config.go`:
```go
package api

import (
	"context"

	gen "github.com/refsdal/pjokk/server/internal/api/gen"
)

// GetConfig implements GET /api/config. Unauthenticated (tierPublic): the
// /login and /join screens read it to decide which account-creation paths
// to offer — the credential signup form (only under OPEN_SIGNUP) and one
// button per configured OAuth provider (never a dead button). No secrets;
// just two booleans-worth of config the client already infers indirectly.
func (d Deps) GetConfig(_ context.Context, _ gen.GetConfigRequestObject) (gen.GetConfigResponseObject, error) {
	providers := d.OAuthProviders
	if providers == nil {
		providers = []string{}
	}
	return gen.GetConfig200JSONResponse{
		OpenSignup:     d.OpenSignup,
		OauthProviders: providers,
	}, nil
}
```
  (Check the generated field names in `gen/types.gen.go` — oapi-codegen may name them `OpenSignup`/`OauthProviders`; adjust to match.)
  (b) In `api.go`: add to `Deps` struct: `OpenSignup bool` and `OAuthProviders []string`. Add `"GetConfig": tierPublic` to `operationAuthTiers`. Add `"GetConfig": true` to `tierPublicAPIAllowlist`.
  (c) In `cmd/pjokk/main.go` `buildDeps`, populate the fields:
```go
OpenSignup:     cfg.OpenSignup,
OAuthProviders: oauthProviders(cfg),
```
  and add a helper in main.go:
```go
// oauthProviders lists the OAuth provider ids the SPA may offer, derived
// from which credentials are configured. Google today; the list grows as
// providers are added, and the SPA renders one button per id.
func oauthProviders(cfg *config.Config) []string {
	var p []string
	if cfg.GoogleClientID != "" && cfg.GoogleClientSecret != "" {
		p = append(p, "google")
	}
	return p
}
```

- [ ] **Step 5: Run to verify it passes** — `go test -p 1 -count=1 ./internal/api/ ./cmd/...` and `go build ./...`. Verify `go generate ./...` leaves no diff. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(api): public /api/config exposing openSignup + oauthProviders"`.

---

### Task 3: Frontend — generic social sign-in + config query

**Files:**
- Modify: `apps/frontend/src/lib/auth-client.ts` (add `signIn.social(provider, redirect)`; keep `google` as an alias)
- Create/Modify: `apps/frontend/src/lib/data/config.ts` (new `useConfig`), export from `lib/data/index.ts`
- Regenerate the client schema: root `bun run gen:client` (picks up `GET /api/config`)
- Test: `apps/frontend/test/` is thin (unit only); no component test framework here, so this task's verification is `typecheck` + the E2E in Task 6. No new unit test file.

**Interfaces:**
- Produces: `signIn.social(provider: string, redirectTo: string): Promise<void>`; `signIn.google` stays as `(redirectTo) => social("google", redirectTo)`. `useConfig(): { data?: { openSignup: boolean; oauthProviders: string[] }, isPending, ... }`.

- [ ] **Step 1: Regenerate the typed client.** From repo root: `bun run gen:client` (runs openapi-typescript against `openapi/pjokk.yaml`). Confirm `paths["/api/config"]` appears in `apps/frontend/src/lib/api-schema.d.ts`.

- [ ] **Step 2: Generic social in `auth-client.ts`.** Replace the `google` method body with a generic one and an alias:
```go
// (TypeScript)
```
```ts
/**
 * Any configured OAuth provider. Resolves the provider's authorization URL
 * and navigates there; the callback returns the browser to `redirectTo`.
 * Clears the cache first because the navigation leaves the page for good.
 */
async social(provider: string, redirectTo: string): Promise<void> {
  await resetCache();
  await authClient.signIn.social({
    provider,
    redirectUri: absoluteUrl(redirectTo),
  });
},
/** Back-compat alias; call sites may migrate to social("google", …). */
async google(redirectTo: string): Promise<void> {
  return this.social("google", redirectTo);
},
```

- [ ] **Step 3: `lib/data/config.ts`.**
```ts
import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "@/lib/api";
import type { components } from "@/lib/api-schema";

export type ClientConfig = components["schemas"] extends { Config: infer C }
  ? C
  : { openSignup: boolean; oauthProviders: string[] };

// Public, static-ish config: which account-creation paths to offer. Not
// routing-critical the way `me` is, so an ordinary cached query is fine.
export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: async () =>
      unwrap<{ openSignup: boolean; oauthProviders: string[] }>(
        client.GET("/api/config"),
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
```
  Export `useConfig` from `apps/frontend/src/lib/data/index.ts` (follow how `useMe` is re-exported).

- [ ] **Step 4: Verify** — `bun run typecheck` and `bun run check`. Expected: clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(frontend): generic social sign-in and useConfig query"`.

---

### Task 4: Frontend — Login screen (provider buttons + bootstrap signup form) (#27)

**Files:**
- Modify: `apps/frontend/src/screens/Login.tsx`
- Add a provider label map (inline in Login.tsx or a tiny `lib/oauth.ts`): `{ google: "Continue with Google" }`.

**Interfaces:**
- Consumes: `useConfig()`, `signIn.social`, `signIn.password`, and the credential signup endpoint via the generated client `client.POST("/api/auth/signup/credential", { body: { email, password } })`.

- [ ] **Step 1: Read** the current `Login.tsx` fully (it has: Google button, "or", email/password sign-in form). Note the exact `t()` strings and structure.

- [ ] **Step 2: Implement.**
  - Call `const config = useConfig();`.
  - Replace the single hardcoded Google button with a loop over `config.data?.oauthProviders ?? []`, rendering one button per provider using the label map; each calls `signIn.social(provider, "/home")`. Render nothing (and hide the "or" divider) when the list is empty.
  - Add a mode toggle ("Sign in" / "Create account") shown ONLY when `config.data?.openSignup`. In "Create account" mode the submit calls:
```ts
await unwrap(client.POST("/api/auth/signup/credential", { body: { email, password } }));
await signIn.password(email, password); // sign in with the just-created account
```
  then navigate to `/home` (a fresh account has no family → the shell routes to `/welcome`; that's correct). Surface errors via the existing `toast(...)` pattern. Keep credential sign-in exactly as today for the "Sign in" mode.
  - The signup form is the ONLY new copy: reuse existing Email/Password placeholders; add `t("Create account")` and `t("Have an account? Sign in")` toggle strings (add them to `lib/i18n.ts` in both locales — English default + a Norwegian translation, matching neighbouring entries).

- [ ] **Step 3: Verify** — `bun run typecheck`, `bun run check` (i18n coverage must pass — every new `t()` key needs both locales), `cd apps/frontend && bun run build`. Expected: clean.

- [ ] **Step 4: Commit** — `git commit -am "feat(frontend): config-driven login — provider buttons + bootstrap signup form"`.

---

### Task 5: Frontend — Join auto-redeem + provider buttons; Welcome closed-signup state (#26)

**Files:**
- Modify: `apps/frontend/src/screens/Join.tsx`
- Modify: `apps/frontend/src/screens/Welcome.tsx`

**Interfaces:**
- Consumes: `useConfig()`, `signIn.social`, `useSession`, the existing `POST /api/invites/redeem`.

- [ ] **Step 1: Join — provider buttons.** Replace the single Google button (`googleSignIn`) with the same per-provider loop as Login (from `useConfig().data.oauthProviders`), each calling `signIn.social(provider, joinPath)` (so OAuth state carries `/join/CODE`). Keep the label map shared (import from `lib/oauth.ts` if extracted).

- [ ] **Step 2: Join — auto-redeem on return.** Today a signed-in visitor must click "Join family". Change so that when the visitor is signed in AND the invite is valid AND they are not already busy, redemption runs automatically (once) on mount. Use an effect guarded by a ref so it fires exactly once:
```ts
const didAuto = useRef(false);
useEffect(() => {
  if (didAuto.current) return;
  if (session && info.data?.valid && !busy) {
    didAuto.current = true;
    void redeem();
  }
}, [session, info.data?.valid, busy]);
```
  Keep the manual "Join family" button as a fallback for the already-signed-in-different-family case and for when auto-redeem errored (reset `didAuto` on error inside `redeem`'s catch so the button works). `redeem` already switches the family and navigates to `/home`.

- [ ] **Step 3: Welcome — closed-signup no-create state.** In `Welcome.tsx`, when the user is family-less AND `!config.openSignup` AND not a sysadmin, show the "you need an invite" state instead of the create-family form (the form would 403 now). Sysadmin detection: `useMe().data?.role === "admin"`. Concretely: gate the create-family form on `config.data?.openSignup || isSysadmin`; otherwise render the existing "Invited to a family?" guidance prominently. Reuse existing strings; add `t()` for any new copy (both locales).

- [ ] **Step 4: Verify** — `bun run typecheck`, `bun run check`, `bun run build`. Expected: clean.

- [ ] **Step 5: Commit** — `git commit -am "feat(frontend): join auto-redeem + provider buttons; welcome closed-signup state"`.

---

### Task 6: E2E coverage + docs

**Files:**
- Modify: `e2e/invite.spec.ts` (brand-new-invitee auto-redeem) and `e2e/auth.spec.ts` (signup form under open signup)
- Modify: `e2e/helpers.ts` if a helper is useful
- Modify: `README.md`, `CLAUDE.md`, `DECISIONS.md`
- Close issues #26 and #27 in the PR body (Task 7)

**Interfaces:**
- Consumes: the running e2e stack (`bash scripts/e2e-stack.sh up`, `OPEN_SIGNUP=1`) and `testrig`-style API fixtures. Real OAuth can't run in CI, so account creation is via the API as existing fixtures do.

- [ ] **Step 1: E2E — brand-new invitee auto-redeems.** Add to `e2e/invite.spec.ts` a test: an admin creates an invite; a brand-new invitee (fresh account via `apiSignup` + `apiSignIn` in a new context — modelling "just created via OAuth") opens `/join/CODE` and, WITHOUT clicking, lands on `/home` with the family visible (asserts the auto-redeem effect). This exercises the #26 client flow end-to-end minus the un-runnable OAuth hop.
```ts
test("a brand-new invitee auto-redeems on opening the join link", async ({ page, request, browser }) => {
  await freshFamily(page, request, "autojoin");
  await page.goto("/settings");
  await page.getByRole("button", { name: "New invite link" }).click();
  const link = await page.getByText(/\/join\//).first().textContent();
  const code = link!.trim().split("/join/")[1]?.trim();

  const inviteeEmail = freshEmail("autoinvitee");
  await apiSignup(request, inviteeEmail);
  const ctx = await browser.newContext();
  const invitee = await ctx.newPage();
  await apiSignIn(invitee, inviteeEmail);
  await invitee.goto(`/join/${code}`);
  // No button click: the join screen auto-redeems a signed-in visitor.
  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(invitee.getByText("Baby autojoin").first()).toBeVisible();
  await ctx.close();
});
```

- [ ] **Step 2: E2E — signup form under open signup.** Add to `e2e/auth.spec.ts` (the stack runs `OPEN_SIGNUP=1`): the Login screen offers a "Create account" mode; switching to it, submitting a fresh email+password, creates an account and lands on `/welcome`.
```ts
test("the login screen creates an account when signup is open", async ({ page }) => {
  const email = freshEmail("uisignup");
  await page.goto("/login");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /Create account/ }).click();
  await expect(page).toHaveURL(/\/(welcome|home)/, { timeout: 10_000 });
});
```
  (Adjust selectors to the actual toggle/button text chosen in Task 4.)

- [ ] **Step 3: Run E2E on a fresh stack** — `bash scripts/e2e-stack.sh down; E2E_REBUILD=1 bash scripts/e2e-stack.sh up; cd e2e && bunx playwright test`. Expected: all pass (7 existing + 2 new).

- [ ] **Step 4: Docs.** README: the bootstrap section now says a signup UI exists (start with `OPEN_SIGNUP=1`, use the login screen's "Create account"); note invitees onboard via any configured OAuth provider through `/join`. CLAUDE.md auth section: reword the closed-alpha guarantee to "no ACCESS without an invite" and note family-creation is OPEN_SIGNUP-or-sysadmin gated. DECISIONS.md: dated entry summarizing the design + accepted residual (inert OAuth accounts, purged after 7 days).

- [ ] **Step 5: Commit** — `git commit -am "test(e2e): invitee auto-redeem + login signup; docs for invitee signup"`.

---

### Task 7: Full verification + PR

- [ ] **Step 1:** `cd apps/server && go vet ./... && go test -p 1 -count=1 ./...` — green.
- [ ] **Step 2:** `bun run check && bun test apps/frontend && cd apps/frontend && bun run build` — green.
- [ ] **Step 3:** Spec drift: `cd apps/server && go generate ./...` + `bun run gen:client`; `git status --porcelain` empty.
- [ ] **Step 4:** Fresh-stack E2E once more: all pass.
- [ ] **Step 5:** Push `invitee-signup`; open the PR to `main` titled `feat: invitee signup via OAuth + signup UI (closes #26, #27)`. Body: the design summary (guard family-creation not account-existence; provider-agnostic /api/config; credential signup only via OPEN_SIGNUP bootstrap), the accepted residual (inert OAuth accounts self-purged), and `Closes #26` / `Closes #27`. Footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Note in the body that merging cuts a release.
