# User Profile, Avatars and the Account Sheet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every user a global profile (full name, nickname, phone, photo) edited on `/profile`, render the photo everywhere a person is shown, and add an account sheet on Home that reaches the profile, switches family safely, and signs out.

**Architecture:** Five new columns on Limen's `users` table, one of them a stored generated `display_name` that every attribution join switches to. Profile writes go through a spec-first `PATCH /api/me`; avatar bytes go through the storage port under hand-mounted multipart/streaming routes, re-encoded server-side to JPEG. The Google picture is imported once on the first `GET /api/me`. On the client, one `Avatar` component with an initials fallback, a `/profile` screen, an account sheet, and a localStorage "family fence" that resets the cache whenever the family behind the session changes.

**Tech Stack:** Go 1.27 stdlib `net/http` + `image/jpeg`/`image/png`/`image/draw`, sqlc + goose over pgx, oapi-codegen strict server, kin-openapi validation; Vite + React + TanStack Router/Query, vaul sheets, Tailwind; bun test; Playwright.

**Spec:** `docs/superpowers/specs/2026-09-06-user-profile-and-avatar-design.md`

**One deviation from the spec, decided while planning:** spec §1 says the `Session` struct gains the profile columns "so GetMe needs no second query". `PATCH /api/me` has to re-read the row after writing anyway, so both handlers use one `GetUserProfile` query and `auth.Session` / `GetAuthSession` stay untouched. One tiny extra query per `/api/me`; one fewer package edited.

## Global Constraints

- **Test database:** `docker compose -f docker-compose.test.yml up -d` publishes 55432. On this machine that port is held by another project: run the test Postgres on 56432 and export `TEST_DATABASE_URL` accordingly (see memory note "Local test env quirks"). Go and sqlc are off PATH: `export PATH=$PATH:$HOME/.local/go/bin:$HOME/go/bin` at the start of every shell.
- **Go tests:** `cd apps/server && go test -p 1 ./...` — `-p 1` is REQUIRED (packages truncate shared tables).
- **Spec first:** every JSON route lives in `openapi/pjokk.yaml`; after editing it run `cd apps/server && go generate ./...` (copies the YAML into `internal/api/pjokk.yaml` and regenerates `internal/api/gen`) and `bun run gen:client` from the repo root. Never hand-edit generated files.
- **sqlc:** after editing anything under `apps/server/internal/db/queries` or `migrations`, run `cd apps/server && sqlc generate`. Generated Go is committed.
- **Tenancy:** every domain query keeps `family_id` in its WHERE. The profile is user-scoped by design, and the one cross-user read (`GetAvatarForViewer`) is scoped by shared membership in SQL.
- **Storage:** only through `storage.Storage`. Keys are server-generated: `avatars/{userId}/{uuid}.jpg`.
- **Errors:** `{error, code}` envelopes; codes used here: `VALIDATION`, `NO_FILE`, `BAD_TYPE`, `TOO_LARGE`, `NOT_FOUND`, `UNAUTHENTICATED`.
- **Frontend:** every user-facing string through `t()` with an `nb` entry in `apps/frontend/src/lib/i18n.ts`; `bun run check` (biome + i18n coverage + typecheck) must pass. Touch targets ≥ 44 px on tappable rows. No react-hook-form — the codebase uses plain `useState` forms (BabySheet), follow that.
- **Night mode** is untouched: no avatar in `NightHome`.
- **Commits:** Conventional Commits, small and scoped, each ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN
  ```
- **Branch:** work on a feature branch `feat/user-profile` off `main` (create it in Task 1, Step 1).

## File Structure

**Server (`apps/server`)**
- Create `internal/db/migrations/00006_user_profile.sql` — the five columns.
- Create `internal/db/queries/profile.sql` — `GetUserProfile`, `UpdateUserProfile`, `SetUserAvatar`, `MarkAvatarImportAttempted`, `GetAvatarForViewer`.
- Modify `internal/db/queries/{feeds,diapers,sleep,other_logs,play,vaccines,timeline,summary,export,calendar,family}.sql` — `u."name"` → `u."display_name"`; `family.sql` also `u."image"` → `u."avatar_key"`.
- Modify `internal/api/me.go` — `buildMe`, `avatarURL`, `UpdateMe`, import hook.
- Create `internal/api/avatar.go` — `normalizeAvatar`, `storeAvatar`, the three hand-routed handlers, `sessionChain`, `mountAvatarRoutes`.
- Create `internal/api/avatar_import.go` — `AvatarImporter`, `GoogleAvatarHost`, `upsizeGoogleAvatar`, `importGoogleAvatar`.
- Modify `internal/api/api.go` — `Deps.AvatarImport`, `"UpdateMe": tierSession`, mount call, `skipSpecValidation` cases.
- Modify `internal/api/babies.go` — `ListFamilyMembers` serialises `AvatarUrl`.
- Modify `internal/api/admin.go`, `internal/jobs/purge.go` — delete the avatar object with the user.
- Modify `internal/testrig/http.go` — `AppRig.Configure`.
- Modify `cmd/pjokk/main.go` — wire `AvatarImport`.
- Tests: `internal/api/profile_test.go`, `me_test.go` (extend), `avatar_test.go`, `avatar_import_test.go`, `admin_test.go` (extend), `internal/jobs/purge_test.go` (extend).

**Spec:** `openapi/pjokk.yaml` — `Me` fields, `UpdateMe` schema + `patch /api/me`, `Member.avatarUrl`.

**Shared:** `packages/shared/src/schemas.ts` — `MemberSchema.avatarUrl`.

**Frontend (`apps/frontend/src`)**
- Create `components/Avatar.tsx` — the one face component + `initialOf`.
- Create `lib/data/profile.ts` — `useUpdateMe`, `useUploadAvatar`, `useDeleteAvatar`.
- Create `lib/avatar-image.ts` — `prepareAvatar` (crop + resize on device).
- Create `lib/family-fence.ts` — `judgeFamily`, `readFence`, `writeFence`.
- Create `screens/Profile.tsx` — the `/profile` screen.
- Create `components/sheets/AccountSheet.tsx` — profile row, families, sign out.
- Modify `lib/data/family.ts` (`useMemberAvatars`), `lib/data/index.ts`, `lib/query.ts` (fence clear + NEVER_PERSIST), `lib/selected-baby.ts` (`clearSelectedBaby`), `components/Chips.tsx` (`leading`), `screens/Home.tsx`, `screens/Timeline.tsx`, `screens/settings/FamilySection.tsx`, `screens/settings/index.tsx`, `screens/shell.tsx`, `components/sheets/EventSheet.tsx`, `router.tsx`, `lib/i18n.ts`.
- Tests: `apps/frontend/test/avatar.test.tsx`, `apps/frontend/test/family-fence.test.ts`.

**E2E:** `e2e/profile.spec.ts`.

**Docs:** `CLAUDE.md`, `DECISIONS.md`.

---

### Task 1: Migration, profile queries, and display-name attribution

**Files:**
- Create: `apps/server/internal/db/migrations/00006_user_profile.sql`
- Create: `apps/server/internal/db/queries/profile.sql`
- Modify: `apps/server/internal/db/queries/feeds.sql`, `diapers.sql`, `sleep.sql`, `other_logs.sql`, `play.sql`, `vaccines.sql`, `timeline.sql`, `summary.sql`, `export.sql`, `calendar.sql`, `family.sql`
- Test: `apps/server/internal/api/profile_test.go`

**Interfaces:**
- Produces (sqlc-generated, package `dbgen`):
  - `GetUserProfile(ctx, id string) (GetUserProfileRow, error)` with fields `ID string, Name string, Nickname *string, Phone *string, DisplayName string, AvatarKey *string, AvatarImportedAt pgtype.Timestamptz, Image *string`
  - `UpdateUserProfile(ctx, UpdateUserProfileParams{ID string, Name *string, Nickname *string, Phone *string}) error`
  - `SetUserAvatar(ctx, SetUserAvatarParams{ID string, AvatarKey *string}) error`
  - `MarkAvatarImportAttempted(ctx, MarkAvatarImportAttemptedParams{ID string, AvatarImportedAt pgtype.Timestamptz}) error`
  - `GetAvatarForViewer(ctx, GetAvatarForViewerParams{TargetID, ViewerID string}) (*string, error)`
  - `ListFamilyMembersRow.AvatarKey *string` (replaces `.Image`)

- [ ] **Step 1: Branch**

```bash
cd /home/anders/projects/refsdal/pjokk && git checkout -b feat/user-profile main
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/internal/api/profile_test.go`:

```go
package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func strp(s string) *string { return &s }

// display_name is a stored generated column: nickname when set (after
// trimming), else the full name. It is the ONE place the rule lives
// (spec §1), so this pins the column itself before any route uses it.
func TestDisplayNameFallsBackToFullName(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	id := a.SignUp("Anders Olsen", "anders@example.com")

	p, err := a.Deps.Q.GetUserProfile(ctx, id)
	if err != nil {
		t.Fatalf("GetUserProfile: %v", err)
	}
	if p.DisplayName != "Anders Olsen" {
		t.Errorf("display_name = %q, want the full name", p.DisplayName)
	}

	if err := a.Deps.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: id, Name: strp("Anders Olsen"), Nickname: strp("Pappa"), Phone: nil,
	}); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	p, _ = a.Deps.Q.GetUserProfile(ctx, id)
	if p.DisplayName != "Pappa" {
		t.Errorf("display_name = %q, want the nickname", p.DisplayName)
	}

	// A blank nickname is no nickname.
	if err := a.Deps.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: id, Name: strp("Anders Olsen"), Nickname: strp("   "), Phone: nil,
	}); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	p, _ = a.Deps.Q.GetUserProfile(ctx, id)
	if p.DisplayName != "Anders Olsen" {
		t.Errorf("display_name after blank nickname = %q, want the full name", p.DisplayName)
	}
}

// Every attribution join reads display_name, so a nickname shows up as
// caretakerName on the logs the family sees — without the frontend knowing
// the rule.
func TestAttributionUsesDisplayName(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Liv")

	res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create feed: %d %s", res.Status, res.Raw)
	}

	var userID string
	if err := a.Rig.Pool.QueryRow(ctx, `SELECT "id" FROM "users" WHERE "email" = $1`, "parent@example.com").Scan(&userID); err != nil {
		t.Fatalf("user id: %v", err)
	}
	if err := a.Deps.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: userID, Name: strp("Rig admin"), Nickname: strp("Mamma"), Phone: nil,
	}); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}

	list := a.DoArray(http.MethodGet, "/api/feeds", cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("list feeds: %d %s", list.Status, list.Raw)
	}
	first := list.JSON[0].(map[string]any)
	if first["caretakerName"] != "Mamma" {
		t.Errorf("caretakerName = %v, want the nickname", first["caretakerName"])
	}

	members := a.DoArray(http.MethodGet, "/api/family/members", cookie, nil)
	if members.Status != http.StatusOK || len(members.JSON) != 1 {
		t.Fatalf("list members: %d %s", members.Status, members.Raw)
	}
	if m := members.JSON[0].(map[string]any); m["name"] != "Mamma" {
		t.Errorf("member name = %v, want the nickname", m["name"])
	}
}
```

Note: if `POST /api/feeds` returns 200 rather than 201 in `feeds_test.go`'s happy path, match that status here.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/server && go test -p 1 ./internal/api -run 'TestDisplayName|TestAttributionUsesDisplayName' 2>&1 | head -20
```
Expected: compile error — `GetUserProfile`/`UpdateUserProfile` undefined.

- [ ] **Step 4: Write the migration**

Create `apps/server/internal/db/migrations/00006_user_profile.sql`:

```sql
-- +goose Up

-- ===========================================================================
-- User profile (spec: docs/superpowers/specs/2026-09-06-user-profile-and-
-- avatar-design.md). Global, per user, the same in every family.
--
--   nickname            shown instead of the full name wherever the family
--                       sees a person; NULL/blank = use the full name
--   phone               private to the user for now (not on Member)
--   avatar_key          storage.Storage key of the JPEG; NULL = no photo
--   avatar_imported_at  set the first time a Google picture import is
--                       ATTEMPTED, success or not, so a photo the user
--                       removed is never silently re-imported
--   display_name        THE one place the "nickname, else full name" rule
--                       lives: every attribution join reads this column, so
--                       neither the handlers nor the SPA know the rule
--
-- `image` (00001_init.sql) keeps its meaning — the picture URL Google's
-- profile mapping writes at sign-in — and is now only an import source.
-- ===========================================================================
ALTER TABLE "users"
    ADD COLUMN "nickname" text,
    ADD COLUMN "phone" text,
    ADD COLUMN "avatar_key" text,
    ADD COLUMN "avatar_imported_at" timestamptz,
    ADD COLUMN "display_name" text GENERATED ALWAYS AS
        (COALESCE(NULLIF(btrim("nickname"), ''), "name", '')) STORED;

-- +goose Down
ALTER TABLE "users"
    DROP COLUMN "display_name",
    DROP COLUMN "avatar_imported_at",
    DROP COLUMN "avatar_key",
    DROP COLUMN "phone",
    DROP COLUMN "nickname";
```

- [ ] **Step 5: Write the profile queries**

Create `apps/server/internal/db/queries/profile.sql`:

```sql
-- Queries backing the user profile (GET/PATCH /api/me, the avatar routes in
-- internal/api/avatar.go, and the Google import in avatar_import.go). All
-- user-scoped: a profile is global, not a family resource.

-- name: GetUserProfile :one
-- display_name is a generated column and therefore nullable to sqlc's eyes;
-- COALESCE so Go sees a string.
SELECT
    "id",
    COALESCE("name", '') AS name,
    "nickname",
    "phone",
    COALESCE("display_name", '') AS display_name,
    "avatar_key",
    "avatar_imported_at",
    "image"
FROM "users"
WHERE "id" = $1;

-- name: UpdateUserProfile :exec
-- Full-row write of the three editable fields; the handler resolves the
-- PATCH tri-state (absent / null / value) before calling this.
UPDATE "users"
SET "name" = $2, "nickname" = $3, "phone" = $4, "updated_at" = now()
WHERE "id" = $1;

-- name: SetUserAvatar :exec
-- NULL clears the photo. The caller deletes the previous object.
UPDATE "users"
SET "avatar_key" = $2, "updated_at" = now()
WHERE "id" = $1;

-- name: MarkAvatarImportAttempted :exec
UPDATE "users"
SET "avatar_imported_at" = $2
WHERE "id" = $1;

-- name: GetAvatarForViewer :one
-- The viewer may see the target's photo when they ARE the target or share
-- at least one family with them. No row for anyone else — and no row for a
-- user without a photo — so the route answers 404 either way and never
-- confirms that a user id exists.
SELECT u."avatar_key"
FROM "users" u
WHERE u."id" = @target_id
  AND u."avatar_key" IS NOT NULL
  AND (
    u."id" = @viewer_id
    OR EXISTS (
      SELECT 1
      FROM "organization_members" a
      JOIN "organization_members" b ON b."organization_id" = a."organization_id"
      WHERE a."user_id" = @viewer_id AND b."user_id" = @target_id
    )
  );
```

- [ ] **Step 6: Switch the attribution joins to display_name**

```bash
cd apps/server/internal/db/queries && sed -i 's/u\."name"/u."display_name"/g' feeds.sql diapers.sql sleep.sql other_logs.sql play.sql vaccines.sql timeline.sql summary.sql export.sql calendar.sql family.sql && grep -c 'display_name' feeds.sql diapers.sql sleep.sql other_logs.sql play.sql vaccines.sql timeline.sql summary.sql export.sql calendar.sql family.sql
```
Every listed file must report at least 1. Do NOT touch `auth.sql`, `admin.sql`, `middleware.sql` (spec §1: the session's own name, the audit trail and the API-key join keep the full name).

Then in `family.sql`, replace the member list's `u."image",` line with `u."avatar_key",` and add a comment above it:

```sql
    -- The storage key, not a URL: internal/api/babies.go's ListFamilyMembers
    -- turns it into /api/users/{id}/avatar?v=… (nil = no photo).
    u."avatar_key",
```

- [ ] **Step 7: Regenerate sqlc and build**

```bash
cd apps/server && sqlc generate && go build ./... 2>&1 | head
```
Expected: `internal/api/babies.go` fails to compile (`row.Image` undefined). Fix `ListFamilyMembers` in `babies.go` for now by replacing `Image: row.Image,` with `Image: nil,` — Task 2 replaces the field for real. Rebuild until clean.

- [ ] **Step 8: Run the tests**

```bash
cd apps/server && go test -p 1 ./internal/api -run 'TestDisplayName|TestAttributionUsesDisplayName' -v 2>&1 | tail -15
```
Expected: both PASS. (The rig migrates the test database on first use, so 00006 is applied automatically.)

Then the whole suite, since the join rename touches every log route:
```bash
cd apps/server && go test -p 1 ./... 2>&1 | tail -30
```
Expected: all packages `ok`. `backup_tables_test.go` still passes (no new table).

- [ ] **Step 9: Commit**

```bash
git add apps/server/internal/db apps/server/internal/api/babies.go apps/server/internal/api/profile_test.go
git commit -m "feat(profile): user profile columns and a display_name every attribution join reads

Adds nickname, phone, avatar_key, avatar_imported_at and a stored
generated display_name (nickname, else full name) to users, plus the
profile queries. Every join that shows a person to their family reads
display_name; auth, admin and the API-key join keep the full name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 2: Spec — `Me` fields, `PATCH /api/me`, `Member.avatarUrl`

**Files:**
- Modify: `openapi/pjokk.yaml` (paths `/api/me`, schemas `Me`, `UpdateMe`, `Member`)
- Modify: `apps/server/internal/api/me.go`, `apps/server/internal/api/api.go` (tier map), `apps/server/internal/api/babies.go` (`ListFamilyMembers`)
- Modify: `apps/frontend/src/lib/api-schema.d.ts` (generated)
- Test: `apps/server/internal/api/me_test.go`

**Interfaces:**
- Consumes: Task 1's `GetUserProfile`, `UpdateUserProfile`, `ListFamilyMembersRow.AvatarKey`; existing `rawBodyFields`, `patchField` (`patch.go`), `errNoRequestBody` (`babies.go`).
- Produces: `func (d Deps) buildMe(ctx context.Context, session *auth.Session) (gen.Me, error)`; `func avatarURL(userID string, key *string) *string`; generated `gen.UpdateMeRequestObject`, `gen.UpdateMe200JSONResponse`, `gen.UpdateMe400JSONResponse`; `gen.Me{DisplayName string, Nickname *string, Phone *string, AvatarUrl *string, …}`; `gen.Member{AvatarUrl *string, …}`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/internal/api/me_test.go`:

```go
func TestGetMeCarriesProfileFields(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo Person", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["displayName"] != "Solo Person" {
		t.Errorf("displayName = %v, want the full name", res.JSON["displayName"])
	}
	for _, field := range []string{"nickname", "phone", "avatarUrl"} {
		if v, ok := res.JSON[field]; !ok || v != nil {
			t.Errorf("%s = %v (present %v), want an explicit null", field, v, ok)
		}
	}
}

func TestUpdateMeEditsTheProfile(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo Person", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{
		"name":     "  Anders Olsen ",
		"nickname": "Pappa",
		"phone":    "+47 900 00 000",
	})
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Anders Olsen" {
		t.Errorf("name = %v, want trimmed", res.JSON["name"])
	}
	if res.JSON["displayName"] != "Pappa" || res.JSON["nickname"] != "Pappa" {
		t.Errorf("displayName/nickname = %v/%v, want Pappa", res.JSON["displayName"], res.JSON["nickname"])
	}
	if res.JSON["phone"] != "+47 900 00 000" {
		t.Errorf("phone = %v", res.JSON["phone"])
	}

	// null clears; an absent key leaves the field alone.
	res = a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"nickname": nil})
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if v := res.JSON["nickname"]; v != nil {
		t.Errorf("nickname after null = %v, want null", v)
	}
	if res.JSON["displayName"] != "Anders Olsen" {
		t.Errorf("displayName after clearing nickname = %v, want the full name", res.JSON["displayName"])
	}
	if res.JSON["phone"] != "+47 900 00 000" {
		t.Errorf("phone was touched by a patch that omitted it: %v", res.JSON["phone"])
	}

	// The session's own name follows the edit too.
	res = a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.JSON["name"] != "Anders Olsen" {
		t.Errorf("GET name = %v, want the edited name", res.JSON["name"])
	}
}

func TestUpdateMeRejectsBadInput(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo Person", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	cases := []struct {
		name string
		body map[string]any
	}{
		{"blank name", map[string]any{"name": "   "}},
		{"nickname over 40 chars", map[string]any{"nickname": strings.Repeat("x", 41)}},
		{"phone with letters", map[string]any{"phone": "call me"}},
		{"phone over 32 chars", map[string]any{"phone": strings.Repeat("1", 33)}},
	}
	for _, tc := range cases {
		res := a.Do(http.MethodPatch, "/api/me", cookie, tc.body)
		if res.Status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, body %s, want 400", tc.name, res.Status, res.Raw)
		}
		if res.JSON["code"] != "VALIDATION" {
			t.Errorf("%s: code = %v, want VALIDATION", tc.name, res.JSON["code"])
		}
	}
}

func TestUpdateMeRequiresASession(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodPatch, "/api/me", "", map[string]any{"name": "x"})
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}
```
Add `"strings"` to the file's imports.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/server && go test -p 1 ./internal/api -run 'TestGetMeCarriesProfileFields|TestUpdateMe' 2>&1 | tail -12
```
Expected: `TestGetMeCarriesProfileFields` fails on `displayName`; the PATCH tests get 404/405.

- [ ] **Step 3: Edit the spec**

In `openapi/pjokk.yaml`:

(a) Under `/api/me:` after the `get:` block add:

```yaml
    patch:
      operationId: updateMe
      summary: >-
        Edit the caller's own profile. Global across families, so a session
        but NOT an active family is required. `null` clears nickname or
        phone; an absent field is left alone. Name is trimmed and must not
        be blank; phone may hold digits, spaces, +, -, ( and ).
      tags: [me]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/UpdateMe"
      responses:
        "200":
          description: The updated profile, same shape as GET.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Me"
        "400":
          description: Blank name, or a phone with characters outside the allowed set.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
```

(b) In `Me`, extend `required` with `displayName, nickname, phone, avatarUrl` and add properties:

```yaml
        displayName:
          type: string
          description: >-
            Nickname when set, else name — what every other member sees
            (users.display_name, a generated column).
        nickname:
          type: string
          nullable: true
        phone:
          type: string
          nullable: true
          description: Private to the user; never on Member.
        avatarUrl:
          type: string
          nullable: true
          description: >-
            "/api/users/{userId}/avatar?v=<key>" when the user has a photo,
            else null. The v parameter is the cache-busting version — a new
            upload is a new key.
```

(c) Add schema `UpdateMe` right before `Member`:

```yaml
    UpdateMe:
      type: object
      description: >-
        Every field optional. `nickname` and `phone` accept `null` to
        clear; the handler reads the raw body (internal/api/patch.go) to
        tell null from absent.
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 100
        nickname:
          type: string
          maxLength: 40
          nullable: true
        phone:
          type: string
          maxLength: 32
          nullable: true
```

(d) In `Member`, replace `image` with `avatarUrl` in `required` and in properties:

```yaml
        avatarUrl:
          type: string
          nullable: true
          description: Same shape as Me.avatarUrl; null without a photo.
```

- [ ] **Step 4: Regenerate**

```bash
cd apps/server && go generate ./... && cd ../.. && bun run gen:client && git status --short
```
Expected: `internal/api/pjokk.yaml`, `internal/api/gen/*.gen.go` and `apps/frontend/src/lib/api-schema.d.ts` modified.

- [ ] **Step 5: Register the tier and implement the handlers**

In `apps/server/internal/api/api.go`, directly under `"GetMe": tierSession,` add:
```go
	"UpdateMe": tierSession,
```

Replace the body of `GetMe` in `me.go` and add the new pieces. The file becomes:

```go
package api

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/auth"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// (keep the existing GetMe doc comment)
func (d Deps) GetMe(ctx context.Context, _ gen.GetMeRequestObject) (gen.GetMeResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return nil, fmt.Errorf("api: GetMe reached with no session (RequireSession not wired?)")
	}
	me, err := d.buildMe(ctx, session)
	if err != nil {
		return nil, err
	}
	return gen.GetMe200JSONResponse(me), nil
}

// phonePattern is the whole of what a phone field may hold: digits, spaces
// and the punctuation people actually type. Anything else is a 400 rather
// than something stored and shown back later.
var phonePattern = regexp.MustCompile(`^[0-9 +()\-]+$`)

// UpdateMe implements PATCH /api/me. Session tier, no family: a profile is
// global. Uses the raw-body tri-state (patch.go) so `null` clears nickname
// or phone while an absent key leaves the column alone — the same
// convention every log PATCH follows.
func (d Deps) UpdateMe(ctx context.Context, _ gen.UpdateMeRequestObject) (gen.UpdateMeResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return nil, fmt.Errorf("api: UpdateMe reached with no session (RequireSession not wired?)")
	}

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateMe")
	}
	nameSet, nameVal, err := patchField[string](fields, "name")
	if err != nil {
		return nil, err
	}
	nickSet, nickVal, err := patchField[string](fields, "nickname")
	if err != nil {
		return nil, err
	}
	phoneSet, phoneVal, err := patchField[string](fields, "phone")
	if err != nil {
		return nil, err
	}

	current, err := d.Q.GetUserProfile(ctx, session.UserID)
	if err != nil {
		return nil, err
	}

	name := current.Name
	if nameSet {
		// The spec marks name non-nullable, so validation already refused
		// a literal null; guard anyway rather than dereference nil.
		if nameVal == nil || strings.TrimSpace(*nameVal) == "" {
			return gen.UpdateMe400JSONResponse(gen.Error{Error: "Name cannot be blank", Code: "VALIDATION"}), nil
		}
		name = strings.TrimSpace(*nameVal)
	}
	nickname := current.Nickname
	if nickSet {
		nickname = trimmedOrNil(nickVal)
	}
	phone := current.Phone
	if phoneSet {
		phone = trimmedOrNil(phoneVal)
		if phone != nil && !phonePattern.MatchString(*phone) {
			return gen.UpdateMe400JSONResponse(gen.Error{Error: "Phone may only hold digits, spaces, +, -, ( and )", Code: "VALIDATION"}), nil
		}
	}

	if err := d.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID:       session.UserID,
		Name:     &name,
		Nickname: nickname,
		Phone:    phone,
	}); err != nil {
		return nil, err
	}

	me, err := d.buildMe(ctx, session)
	if err != nil {
		return nil, err
	}
	return gen.UpdateMe200JSONResponse(me), nil
}

// trimmedOrNil turns a PATCH value into what the column stores: nil for
// null, nil for whitespace-only, otherwise the trimmed string.
func trimmedOrNil(v *string) *string {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		return nil
	}
	return &s
}

// avatarURL is the one place the avatar URL shape lives. The version is the
// key's file name (a fresh uuid per upload), so a re-upload is a new URL and
// no <img> ever shows a stale photo from the browser cache.
func avatarURL(userID string, key *string) *string {
	if key == nil || *key == "" {
		return nil
	}
	u := "/api/users/" + userID + "/avatar?v=" + path.Base(*key)
	return &u
}

// buildMe assembles the Me payload from the session and a fresh read of the
// profile row. Shared by GET and PATCH: after a write the row, not the
// session snapshot taken at the start of the request, is the truth.
func (d Deps) buildMe(ctx context.Context, session *auth.Session) (gen.Me, error) {
	profile, err := d.Q.GetUserProfile(ctx, session.UserID)
	if err != nil {
		return gen.Me{}, err
	}

	me := gen.Me{
		UserId:      session.UserID,
		Name:        profile.Name,
		DisplayName: profile.DisplayName,
		Nickname:    profile.Nickname,
		Phone:       profile.Phone,
		AvatarUrl:   avatarURL(session.UserID, profile.AvatarKey),
		Email:       session.Email,
		Version:     d.Version,
	}
	if session.Role != "" {
		role := session.Role
		me.Role = &role
	}
	if session.ImpersonatedBy != "" {
		impersonatedBy := session.ImpersonatedBy
		me.ImpersonatedBy = &impersonatedBy
	}

	if session.ActiveFamilyID != "" {
		familyID := session.ActiveFamilyID
		row, err := d.Q.GetFamilyMembershipRole(ctx, dbgen.GetFamilyMembershipRoleParams{
			OrganizationID: familyID,
			UserID:         session.UserID,
		})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Stale active_organization_id — report "no family", never refuse.
		case err != nil:
			return gen.Me{}, err
		default:
			me.FamilyId = &familyID
			plan := row.Plan
			me.Plan = &plan
			if row.Role != "" {
				role := row.Role
				me.MemberRole = &role
			}
		}
	}
	return me, nil
}
```

In `babies.go`'s `ListFamilyMembers`, replace the `Image: nil,` placeholder with:
```go
			AvatarUrl: avatarURL(row.UserID, row.AvatarKey),
```

- [ ] **Step 6: Build and run**

```bash
cd apps/server && go build ./... && go vet ./... && go test -p 1 ./internal/api -run 'TestGetMe|TestUpdateMe' -v 2>&1 | tail -20
```
Expected: all PASS. If `TestUpdateMeRejectsBadInput`'s "nickname over 40" case gets 400 with a different message, that is kin-openapi's own rejection — the code is still `VALIDATION`, the test only checks the code.

- [ ] **Step 7: Full suite + frontend typecheck**

```bash
cd apps/server && go test -p 1 ./... 2>&1 | tail -30
cd ../.. && bun run typecheck 2>&1 | tail -5
```
Expected: Go all `ok`. The typecheck fails on `packages/shared`'s `MemberSchema.image` vs the generated `avatarUrl` only if something compares the two — if it does, fix in Task 6; note it and move on.

- [ ] **Step 8: Commit**

```bash
git add openapi/pjokk.yaml apps/server apps/frontend/src/lib/api-schema.d.ts
git commit -m "feat(api): PATCH /api/me, profile fields on Me, avatarUrl on Member

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 3: Avatar upload, delete and read routes

**Files:**
- Create: `apps/server/internal/api/avatar.go`
- Modify: `apps/server/internal/api/api.go` (mount + `skipSpecValidation`)
- Test: `apps/server/internal/api/avatar_test.go`

**Interfaces:**
- Consumes: Task 1 queries; Task 2's `buildMe`; `internalError` (`files.go`); `maxMultipartOverhead` (`files.go`); `middleware.APIKeyAuth/Session/RequireSession/RejectAPIKey`.
- Produces: `func normalizeAvatar(src []byte) ([]byte, error)` (JPEG bytes); `errBadImage`, `errTooLarge`; `func (d Deps) storeAvatar(ctx, userID string, jpg []byte) (key string, err error)`; `func sessionChain(d Deps) func(http.Handler) http.Handler`; `func (d Deps) mountAvatarRoutes(mux, chain)`. Routes: `PUT /api/me/avatar`, `DELETE /api/me/avatar`, `GET /api/users/{id}/avatar`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/internal/api/avatar_test.go`:

```go
package api_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func solidPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 80, B: 40, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func solidJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// avatarUpload builds a real multipart PUT /api/me/avatar.
func avatarUpload(t *testing.T, cookie, contentType string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="me.img"`)
	h.Set("Content-Type", contentType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/me/avatar", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	return req
}

func avatarKeys(t *testing.T, a *testrig.AppRig) []string {
	t.Helper()
	objs, err := a.Deps.Storage.(*storage.Memory).List(context.Background(), "avatars/")
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, len(objs))
	for i, o := range objs {
		keys[i] = o.Key
	}
	return keys
}

func TestAvatarUploadStoresAJPEGAndReplacesThePrevious(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.DoRequest(avatarUpload(t, cookie, "image/png", solidPNG(t, 64, 64)))
	if res.Status != http.StatusOK {
		t.Fatalf("png upload: %d %s", res.Status, res.Raw)
	}
	first, _ := res.JSON["avatarUrl"].(string)
	if first == "" {
		t.Fatalf("avatarUrl missing after upload: %s", res.Raw)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Fatalf("objects after first upload = %v, want 1", got)
	}

	res = a.DoRequest(avatarUpload(t, cookie, "image/jpeg", solidJPEG(t, 32, 32)))
	if res.Status != http.StatusOK {
		t.Fatalf("jpeg upload: %d %s", res.Status, res.Raw)
	}
	second, _ := res.JSON["avatarUrl"].(string)
	if second == first {
		t.Errorf("avatarUrl did not change on re-upload: %s", second)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Errorf("objects after second upload = %v, want the old one gone", got)
	}

	// GET /api/me agrees.
	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if me.JSON["avatarUrl"] != second {
		t.Errorf("GET /api/me avatarUrl = %v, want %q", me.JSON["avatarUrl"], second)
	}
}

func TestAvatarUploadRejectsWhatIsNotASmallImage(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	cases := []struct {
		name        string
		contentType string
		data        []byte
		status      int
		code        string
	}{
		{"gif bytes", "image/gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), http.StatusUnsupportedMediaType, "BAD_TYPE"},
		{"text claiming to be jpeg", "image/jpeg", []byte("definitely not a jpeg"), http.StatusUnsupportedMediaType, "BAD_TYPE"},
		{"too many pixels", "image/png", solidPNG(t, 1025, 10), http.StatusRequestEntityTooLarge, "TOO_LARGE"},
		{"too many bytes", "image/png", bytes.Repeat([]byte{0}, 512*1024+1), http.StatusRequestEntityTooLarge, "TOO_LARGE"},
	}
	for _, tc := range cases {
		res := a.DoRequest(avatarUpload(t, cookie, tc.contentType, tc.data))
		if res.Status != tc.status || res.JSON["code"] != tc.code {
			t.Errorf("%s: got %d %v, want %d %s", tc.name, res.Status, res.JSON["code"], tc.status, tc.code)
		}
	}
	if got := avatarKeys(t, a); len(got) != 0 {
		t.Errorf("rejected uploads left objects behind: %v", got)
	}

	req := httptest.NewRequest(http.MethodPut, "/api/me/avatar", bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	if res := a.DoRequest(req); res.Status != http.StatusBadRequest || res.JSON["code"] != "NO_FILE" {
		t.Errorf("no multipart: got %d %v, want 400 NO_FILE", res.Status, res.JSON["code"])
	}
}

func TestAvatarIsVisibleToSelfAndCoMembersOnly(t *testing.T) {
	a := testrig.App(t)
	familyID, ownerCookie := a.NewFamily("Hansen", "owner@example.com")
	var ownerID string
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT "id" FROM "users" WHERE "email" = $1`, "owner@example.com").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	peerID := a.SignUp("Peer", "peer@example.com")
	peerCookie := a.AddMember(familyID, peerID, auth.RoleMember, "peer@example.com")
	a.SignUp("Stranger", "stranger@example.com")
	strangerCookie := a.SignIn("stranger@example.com")

	path := "/api/users/" + ownerID + "/avatar"

	// No photo yet: 404 for everyone, including the owner.
	if res := a.Do(http.MethodGet, path, ownerCookie, nil); res.Status != http.StatusNotFound {
		t.Fatalf("before upload: %d, want 404", res.Status)
	}

	if res := a.DoRequest(avatarUpload(t, ownerCookie, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}

	for _, tc := range []struct {
		who    string
		cookie string
		status int
	}{
		{"owner", ownerCookie, http.StatusOK},
		{"co-member", peerCookie, http.StatusOK},
		{"stranger", strangerCookie, http.StatusNotFound},
		{"anonymous", "", http.StatusUnauthorized},
	} {
		res := a.Do(http.MethodGet, path+"?v=anything", tc.cookie, nil)
		if res.Status != tc.status {
			t.Errorf("%s: status = %d, want %d (body %s)", tc.who, res.Status, tc.status, res.Raw)
			continue
		}
		if tc.status == http.StatusOK {
			if ct := res.Header.Get("Content-Type"); ct != "image/jpeg" {
				t.Errorf("%s: content-type = %q, want image/jpeg", tc.who, ct)
			}
			if res.Header.Get("ETag") == "" || res.Header.Get("Cache-Control") != "private, max-age=86400" {
				t.Errorf("%s: caching headers = %q / %q", tc.who, res.Header.Get("ETag"), res.Header.Get("Cache-Control"))
			}
			if _, format, err := image.DecodeConfig(bytes.NewReader(res.Raw)); err != nil || format != "jpeg" {
				t.Errorf("%s: body is not a decodable jpeg: %v %q", tc.who, err, format)
			}
		}
	}

	// Conditional GET with the served ETag → 304.
	res := a.Do(http.MethodGet, path, peerCookie, nil)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Cookie", peerCookie)
	req.Header.Set("If-None-Match", res.Header.Get("ETag"))
	if res2 := a.DoRequest(req); res2.Status != http.StatusNotModified {
		t.Errorf("If-None-Match: %d, want 304", res2.Status)
	}

	// A pjk_ key has no face to fetch.
	key := a.CreateAPIKey(familyID, ownerID)
	req = httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	if res := a.DoRequest(req); res.Status != http.StatusForbidden && res.Status != http.StatusUnauthorized {
		t.Errorf("API key read: %d, want 401/403", res.Status)
	}
}

func TestAvatarDeleteRemovesTheObject(t *testing.T) {
	a := testrig.App(t)
	id := a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	if res := a.DoRequest(avatarUpload(t, cookie, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	res := a.Do(http.MethodDelete, "/api/me/avatar", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("delete: %d %s", res.Status, res.Raw)
	}
	if v := res.JSON["avatarUrl"]; v != nil {
		t.Errorf("avatarUrl after delete = %v, want null", v)
	}
	if got := avatarKeys(t, a); len(got) != 0 {
		t.Errorf("object survived delete: %v", got)
	}
	if res := a.Do(http.MethodGet, fmt.Sprintf("/api/users/%s/avatar", id), cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("GET after delete: %d, want 404", res.Status)
	}
	// Deleting twice is fine.
	if res := a.Do(http.MethodDelete, "/api/me/avatar", cookie, nil); res.Status != http.StatusOK {
		t.Errorf("second delete: %d, want 200", res.Status)
	}
}
```

Check `CreateAPIKey`'s return in `testrig/http.go` (it returns the raw `pjk_…` token) and the bearer header the API-key middleware expects (`grep -n "Bearer" internal/api/middleware/middleware.go`); adjust the header line if it differs.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/server && go test -p 1 ./internal/api -run 'TestAvatar' 2>&1 | tail -12
```
Expected: 404s / nil-map failures, no compile errors (the test only uses existing rig APIs).

- [ ] **Step 3: Implement `avatar.go`**

Create `apps/server/internal/api/avatar.go`:

```go
package api

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png" // register the PNG decoder for image.Decode
	"io"
	"log"
	"net/http"
	"path"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Avatar routes (spec §2): hand-mounted like the vaccine-document routes in
// files.go, because the strict server has no way to say "multipart in" or
// "JPEG out". Session tier, family NOT required — a profile is global — and
// API keys are refused: an integration has no profile to edit and no need to
// read faces.
//
//   PUT    /api/me/avatar           multipart field "file" → Me
//   DELETE /api/me/avatar           → Me
//   GET    /api/users/{id}/avatar   image/jpeg; 404 unless self or co-member
//
// Whatever arrives is DECODED and RE-ENCODED as JPEG (normalizeAvatar): that
// proves the bytes are an image regardless of the declared content type,
// bounds the pixel count before a full decode, and strips every byte of
// metadata a camera would have embedded — a JPEG written from pixels
// carries no EXIF, so no GPS fix ever reaches the object store.

const (
	// maxAvatarBytes caps the upload (the client resizes to 512 px JPEG
	// first, which lands well under this).
	maxAvatarBytes = 512 * 1024
	// maxAvatarEdge caps width and height, checked from the header alone.
	maxAvatarEdge = 1024
	// avatarJPEGQuality is the re-encode quality.
	avatarJPEGQuality = 85
)

var (
	errBadImage = errors.New("avatar: not a JPEG or PNG image")
	errTooLarge = errors.New("avatar: image exceeds the size limit")
)

// normalizeAvatar decodes src (JPEG or PNG) and returns it as JPEG bytes,
// flattened onto white so a transparent PNG does not come out black.
// DecodeConfig reads only the header, so an oversized image is refused
// without allocating its pixels.
func normalizeAvatar(src []byte) ([]byte, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil || (format != "jpeg" && format != "png") {
		return nil, errBadImage
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxAvatarEdge || cfg.Height > maxAvatarEdge {
		return nil, errTooLarge
	}
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, errBadImage
	}
	bounds := img.Bounds()
	flat := image.NewRGBA(bounds)
	draw.Draw(flat, bounds, image.White, image.Point{}, draw.Src)
	draw.Draw(flat, bounds, img, bounds.Min, draw.Over)

	var out bytes.Buffer
	if err := jpeg.Encode(&out, flat, &jpeg.Options{Quality: avatarJPEGQuality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// storeAvatar writes jpg under a fresh key, points the user at it, and
// deletes the previous object best-effort (a leaked old object is a
// housekeeping problem; a user without their new photo is a bug). Shared by
// the upload route and the Google import.
func (d Deps) storeAvatar(ctx context.Context, userID string, jpg []byte) (string, error) {
	previous, err := d.Q.GetUserProfile(ctx, userID)
	if err != nil {
		return "", err
	}
	key := "avatars/" + userID + "/" + uuid.NewString() + ".jpg"
	if err := d.Storage.Put(ctx, key, bytes.NewReader(jpg), int64(len(jpg)), "image/jpeg"); err != nil {
		return "", err
	}
	if err := d.Q.SetUserAvatar(ctx, dbgen.SetUserAvatarParams{ID: userID, AvatarKey: &key}); err != nil {
		return "", err
	}
	if previous.AvatarKey != nil && *previous.AvatarKey != key {
		if err := d.Storage.Delete(ctx, *previous.AvatarKey); err != nil {
			log.Printf("api: delete previous avatar %s: %v", *previous.AvatarKey, err)
		}
	}
	return key, nil
}

func (d Deps) putAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session := middleware.SessionFromContext(ctx)

	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes+maxMultipartOverhead)
	if err := r.ParseMultipartForm(maxAvatarBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
			return
		}
		respond.Error(w, http.StatusBadRequest, "No file", "NO_FILE")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "No file", "NO_FILE")
		return
	}
	defer file.Close()
	if header.Size <= 0 || header.Size > maxAvatarBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
		return
	}
	src, err := io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if len(src) > maxAvatarBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
		return
	}

	jpg, err := normalizeAvatar(src)
	switch {
	case errors.Is(err, errTooLarge):
		respond.Error(w, http.StatusRequestEntityTooLarge, "Image too large — at most 1024 px on either side", "TOO_LARGE")
		return
	case err != nil:
		respond.Error(w, http.StatusUnsupportedMediaType, "JPEG or PNG only", "BAD_TYPE")
		return
	}

	if _, err := d.storeAvatar(ctx, session.UserID, jpg); err != nil {
		internalError(w, r, err)
		return
	}
	me, err := d.buildMe(ctx, session)
	if err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, me)
}

func (d Deps) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session := middleware.SessionFromContext(ctx)

	profile, err := d.Q.GetUserProfile(ctx, session.UserID)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if profile.AvatarKey != nil {
		if err := d.Q.SetUserAvatar(ctx, dbgen.SetUserAvatarParams{ID: session.UserID, AvatarKey: nil}); err != nil {
			internalError(w, r, err)
			return
		}
		if err := d.Storage.Delete(ctx, *profile.AvatarKey); err != nil {
			internalError(w, r, err)
			return
		}
	}
	me, err := d.buildMe(ctx, session)
	if err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, me)
}

func (d Deps) getUserAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	viewer := middleware.SessionFromContext(ctx)
	target := r.PathValue("id")

	key, err := d.Q.GetAvatarForViewer(ctx, dbgen.GetAvatarForViewerParams{TargetID: target, ViewerID: viewer.UserID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && key == nil) {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}

	etag := `"` + path.Base(*key) + `"`
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	body, found, err := d.Storage.GetStream(ctx, *key)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !found {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	defer body.Close()

	h := w.Header()
	h.Set("Content-Type", "image/jpeg")
	h.Set("ETag", etag)
	// The URL carries the key as ?v=, so a long private cache is safe.
	h.Set("Cache-Control", "private, max-age=86400")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

// sessionChain is the hand-routed twin of authChain's tierSession, plus
// RejectAPIKey: apiKey → session → requireSession → rejectAPIKey.
func sessionChain(d Deps) func(http.Handler) http.Handler {
	mwDeps := middleware.Deps{Auth: d.Auth, Q: d.Q, RateLimit: d.RateLimit, Now: d.Now}
	apiKey := middleware.APIKeyAuth(mwDeps)
	session := middleware.Session(mwDeps)
	requireSession := middleware.RequireSession()
	rejectAPIKey := middleware.RejectAPIKey()
	return func(h http.Handler) http.Handler {
		return apiKey(session(requireSession(rejectAPIKey(h))))
	}
}

// mountAvatarRoutes registers the three avatar handlers on mux behind chain.
func (d Deps) mountAvatarRoutes(mux *http.ServeMux, chain func(http.Handler) http.Handler) {
	mux.Handle("PUT /api/me/avatar", chain(http.HandlerFunc(d.putAvatar)))
	mux.Handle("DELETE /api/me/avatar", chain(http.HandlerFunc(d.deleteAvatar)))
	mux.Handle("GET /api/users/{id}/avatar", chain(http.HandlerFunc(d.getUserAvatar)))
}
```

In `api.go`:
- directly after `d.mountFileRoutes(mux, familyChain(d))` add:
  ```go
	// Avatars (internal/api/avatar.go): multipart in, JPEG out — hand-routed
	// for the same reason as the files routes, but session tier (a profile
	// is global) and never an API key.
	d.mountAvatarRoutes(mux, sessionChain(d))
  ```
- in `skipSpecValidation`, add two cases before `default:`:
  ```go
	case r.URL.Path == "/api/me/avatar":
		return true
	case strings.HasPrefix(r.URL.Path, "/api/users/"):
		return true
  ```
  and extend that function's doc comment list with "the avatar upload (multipart) and avatar streaming routes".

- [ ] **Step 4: Run the tests**

```bash
cd apps/server && go build ./... && go vet ./... && go test -p 1 ./internal/api -run 'TestAvatar' -v 2>&1 | tail -30
```
Expected: all four PASS. If the `rejectAPIKey` middleware returns a status other than 401/403 for a bearer key, read its doc comment in `middleware.go` and align the test's accepted statuses to what it documents.

- [ ] **Step 5: Full suite**

```bash
cd apps/server && go test -p 1 ./... 2>&1 | tail -30
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/internal/api
git commit -m "feat(api): avatar upload, delete and co-member read, re-encoded to JPEG

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 4: Google picture import on the first `GET /api/me`

**Files:**
- Create: `apps/server/internal/api/avatar_import.go`
- Modify: `apps/server/internal/api/api.go` (Deps field), `apps/server/internal/api/me.go` (hook), `apps/server/internal/testrig/http.go` (`Configure`), `apps/server/cmd/pjokk/main.go` (wiring)
- Test: `apps/server/internal/api/avatar_import_test.go`

**Interfaces:**
- Consumes: Task 3's `normalizeAvatar`, `storeAvatar`; Task 1's `GetUserProfile`, `MarkAvatarImportAttempted`.
- Produces: `type AvatarImporter struct { Client *http.Client; AllowedHost func(host string) bool }`; `func GoogleAvatarHost(host string) bool`; `func upsizeGoogleAvatar(raw string) string`; `Deps.AvatarImport *AvatarImporter`; `func (a *AppRig) Configure(fn func(d *api.Deps))` in testrig.

- [ ] **Step 1: Add `Configure` to the rig**

In `apps/server/internal/testrig/http.go`, after `MountProtected`:

```go
// Configure mutates the rig's Deps and marks the handler stale, for a test
// that needs a collaborator the default rig leaves nil (the avatar importer
// pointed at an httptest server). The next request rebuilds the handler.
func (a *AppRig) Configure(fn func(d *api.Deps)) {
	a.t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	fn(&a.Deps)
	a.handler = nil
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/server/internal/api/avatar_import_test.go`:

```go
package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// pictureServer serves one PNG (or a failure) over TLS and counts hits —
// the import requires https, and httptest's TLS client trusts its own cert.
func pictureServer(t *testing.T, status int) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(solidPNG(t, 96, 96))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func setGoogleImage(t *testing.T, a *testrig.AppRig, userID, url string) {
	t.Helper()
	if _, err := a.Rig.Pool.Exec(context.Background(), `UPDATE "users" SET "image" = $1 WHERE "id" = $2`, url, userID); err != nil {
		t.Fatal(err)
	}
}

func allowAll(string) bool { return true }

func TestGoogleAvatarIsImportedOnceOnFirstMe(t *testing.T) {
	a := testrig.App(t)
	srv, hits := pictureServer(t, http.StatusOK)
	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{Client: srv.Client(), AllowedHost: allowAll}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo=s96-c")
	cookie := a.SignIn("g@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d %s", res.Status, res.Raw)
	}
	if res.JSON["avatarUrl"] == nil {
		t.Fatalf("avatarUrl still null after import: %s", res.Raw)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Errorf("objects = %v, want 1", got)
	}

	a.Do(http.MethodGet, "/api/me", cookie, nil)
	if n := atomic.LoadInt32(hits); n != 1 {
		t.Errorf("picture fetched %d times, want exactly once", n)
	}
}

func TestGoogleAvatarImportNeverFetchesOtherHosts(t *testing.T) {
	a := testrig.App(t)
	srv, hits := pictureServer(t, http.StatusOK)
	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{Client: srv.Client(), AllowedHost: api.GoogleAvatarHost}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo")
	cookie := a.SignIn("g@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.JSON["avatarUrl"] != nil {
		t.Errorf("avatarUrl = %v, want null", res.JSON["avatarUrl"])
	}
	if n := atomic.LoadInt32(hits); n != 0 {
		t.Errorf("a non-Google host was fetched %d times", n)
	}
}

func TestGoogleAvatarImportFailureIsAttemptedOnce(t *testing.T) {
	a := testrig.App(t)
	srv, hits := pictureServer(t, http.StatusInternalServerError)
	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{Client: srv.Client(), AllowedHost: allowAll}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo")
	cookie := a.SignIn("g@example.com")

	for i := 0; i < 2; i++ {
		res := a.Do(http.MethodGet, "/api/me", cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("GET /api/me must not fail because Google did: %d %s", res.Status, res.Raw)
		}
		if res.JSON["avatarUrl"] != nil {
			t.Errorf("avatarUrl = %v, want null", res.JSON["avatarUrl"])
		}
	}
	if n := atomic.LoadInt32(hits); n != 1 {
		t.Errorf("failed import retried: %d fetches, want 1", n)
	}
	p, err := a.Deps.Q.GetUserProfile(context.Background(), id)
	if err != nil || !p.AvatarImportedAt.Valid {
		t.Errorf("avatar_imported_at not marked after a failed attempt (err %v)", err)
	}
}

func TestGoogleAvatarHost(t *testing.T) {
	for host, want := range map[string]bool{
		"lh3.googleusercontent.com":       true,
		"googleusercontent.com":           true,
		"evil-googleusercontent.com":      false,
		"googleusercontent.com.evil.test": false,
		"localhost":                       false,
	} {
		if got := api.GoogleAvatarHost(host); got != want {
			t.Errorf("GoogleAvatarHost(%q) = %v, want %v", host, got, want)
		}
	}
}
```

And an internal test for the size hint, `apps/server/internal/api/avatar_import_internal_test.go` (package `api`):

```go
package api

import "testing"

func TestUpsizeGoogleAvatar(t *testing.T) {
	cases := map[string]string{
		"https://lh3.googleusercontent.com/a/abc=s96-c": "https://lh3.googleusercontent.com/a/abc=s512-c",
		"https://lh3.googleusercontent.com/a/abc":        "https://lh3.googleusercontent.com/a/abc",
	}
	for in, want := range cases {
		if got := upsizeGoogleAvatar(in); got != want {
			t.Errorf("upsizeGoogleAvatar(%q) = %q, want %q", in, got, want)
		}
	}
}
```

- [ ] **Step 3: Run to verify they fail**

```bash
cd apps/server && go test -p 1 ./internal/api -run 'TestGoogleAvatar|TestUpsize' 2>&1 | tail -8
```
Expected: compile error — `api.AvatarImporter` undefined.

- [ ] **Step 4: Implement**

Create `apps/server/internal/api/avatar_import.go`:

```go
package api

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Google picture import (spec §3). Limen's OAuth profile mapping
// (internal/auth's googlePlugin) stores Google's picture URL in users.image
// at sign-in. Nothing serves that URL — the CSP forbids third-party images
// and hot-linking would ping Google on every page load — so the first
// GET /api/me after sign-in copies it, once, into our own object store.
//
// The URL is data from a third party: the host allowlist is what stops
// this becoming a server-side request forgery primitive.

const (
	avatarImportTimeout  = 3 * time.Second
	avatarImportMaxBytes = 1 << 20 // 1 MiB
)

// AvatarImporter is the outbound half of the import, handed in through Deps
// so tests point it at an httptest server (with the allowlist widened) and
// production wires the default client + GoogleAvatarHost. nil disables the
// import entirely.
type AvatarImporter struct {
	Client      *http.Client
	AllowedHost func(host string) bool
}

// GoogleAvatarHost is the production allowlist: googleusercontent.com and
// its subdomains, nothing else.
func GoogleAvatarHost(host string) bool {
	host = strings.ToLower(host)
	return host == "googleusercontent.com" || strings.HasSuffix(host, ".googleusercontent.com")
}

// upsizeGoogleAvatar asks for a 512 px rendition instead of Google's default
// 96 px thumbnail — the suffix is Google's documented size hint, and an
// unknown shape is left alone.
func upsizeGoogleAvatar(raw string) string {
	return strings.Replace(raw, "=s96-c", "=s512-c", 1)
}

// importGoogleAvatar runs the import for userID if it has never been
// attempted. Best-effort by design: every failure is logged and swallowed,
// because a Google outage must cost the user their picture, never their
// sign-in. Runs synchronously — worst case one avatarImportTimeout delay,
// once per account lifetime.
func (d Deps) importGoogleAvatar(ctx context.Context, userID string) {
	if d.AvatarImport == nil || d.AvatarImport.Client == nil {
		return
	}
	p, err := d.Q.GetUserProfile(ctx, userID)
	if err != nil || p.AvatarKey != nil || p.AvatarImportedAt.Valid || p.Image == nil {
		return
	}
	u, err := url.Parse(*p.Image)
	if err != nil || u.Scheme != "https" || d.AvatarImport.AllowedHost == nil || !d.AvatarImport.AllowedHost(u.Hostname()) {
		return
	}

	// Mark FIRST: whatever happens below happens once.
	if err := d.Q.MarkAvatarImportAttempted(ctx, dbgen.MarkAvatarImportAttemptedParams{
		ID:               userID,
		AvatarImportedAt: pgtype.Timestamptz{Time: d.Now(), Valid: true},
	}); err != nil {
		log.Printf("api: mark avatar import for %s: %v", userID, err)
		return
	}

	fetchCtx, cancel := context.WithTimeout(ctx, avatarImportTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, upsizeGoogleAvatar(u.String()), nil)
	if err != nil {
		return
	}
	res, err := d.AvatarImport.Client.Do(req)
	if err != nil {
		log.Printf("api: avatar import for %s: %v", userID, err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		log.Printf("api: avatar import for %s: status %d", userID, res.StatusCode)
		return
	}
	src, err := io.ReadAll(io.LimitReader(res.Body, avatarImportMaxBytes+1))
	if err != nil || len(src) > avatarImportMaxBytes {
		log.Printf("api: avatar import for %s: body unreadable or over %d bytes", userID, avatarImportMaxBytes)
		return
	}
	jpg, err := normalizeAvatar(src)
	if err != nil {
		log.Printf("api: avatar import for %s: %v", userID, err)
		return
	}
	if _, err := d.storeAvatar(ctx, userID, jpg); err != nil {
		log.Printf("api: avatar import for %s: store: %v", userID, err)
	}
}
```

In `api.go`'s `Deps`, after `OAuthProviders []string` add:
```go
	// AvatarImport copies a Google profile picture into the object store on
	// the first GET /api/me after sign-in (internal/api/avatar_import.go).
	// nil disables the import; the test rig leaves it nil unless a test
	// Configure()s one.
	AvatarImport *AvatarImporter
```

In `me.go`'s `GetMe`, before `me, err := d.buildMe(ctx, session)`:
```go
	// Once per account: copy Google's picture into our store (no-op unless
	// this is the first /api/me after a Google sign-in — see avatar_import.go).
	d.importGoogleAvatar(ctx, session.UserID)
```

In `cmd/pjokk/main.go`'s `buildDeps`, in the `api.Deps{…}` literal after `OAuthProviders: oauthProviders(cfg),`:
```go
		// Always wired: harmless without Google sign-in (users.image is only
		// ever set by the Google profile mapping), and the host allowlist is
		// the guard, not the presence of credentials.
		AvatarImport: &api.AvatarImporter{
			Client:      &http.Client{Timeout: 5 * time.Second},
			AllowedHost: api.GoogleAvatarHost,
		},
```
Add `"net/http"` to that file's imports if it is not already there.

- [ ] **Step 5: Run the tests**

```bash
cd apps/server && go build ./... && go vet ./... && go test -p 1 ./internal/api -run 'TestGoogleAvatar|TestUpsize' -v 2>&1 | tail -20
```
Expected: all PASS.

- [ ] **Step 6: Full suite, then commit**

```bash
cd apps/server && go test -p 1 ./... 2>&1 | tail -30
git add apps/server
git commit -m "feat(api): import the Google profile picture once, on the first /api/me

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 5: Delete the avatar object when the account goes

**Files:**
- Modify: `apps/server/internal/api/admin.go` (`DeleteAdminUser`), `apps/server/internal/jobs/purge.go` (`PurgeOrphanUsers`)
- Test: `apps/server/internal/api/admin_test.go`, `apps/server/internal/jobs/purge_test.go`

**Interfaces:**
- Consumes: `GetUserProfile`; `storage.Storage.Delete`; existing test helpers `sysadminRig`, `userIDByEmail` (api tests), `depsFor`, `setCreatedAt`, `allUserIDs`, `contains` (jobs tests); Task 3's `avatarUpload`, `avatarKeys` (api tests).

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/internal/api/admin_test.go`:

```go
func TestDeleteAdminUserRemovesTheAvatarObject(t *testing.T) {
	a, _, adminCookie, _ := sysadminRig(t, "Hansen")
	a.SignUp("Target", "target@example.com")
	targetCookie := a.SignIn("target@example.com")
	targetID := userIDByEmail(t, a, "target@example.com")

	if res := a.DoRequest(avatarUpload(t, targetCookie, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Fatalf("precondition: objects = %v", got)
	}

	res := a.Do(http.MethodDelete, "/api/admin/users/"+targetID, adminCookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("delete user: %d %s", res.Status, res.Raw)
	}
	if got := avatarKeys(t, a); len(got) != 0 {
		t.Errorf("avatar object survived the account delete: %v", got)
	}
}
```
(Confirm the admin delete path with `grep -n "/api/admin/users/{id}" openapi/pjokk.yaml` and adjust if it differs.)

Append to `apps/server/internal/jobs/purge_test.go`:

```go
func TestPurgeOrphanUsersRemovesTheAvatarObject(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	orphanID := a.SignUp("Orphan", "orphan@example.com")
	setCreatedAt(t, a, orphanID, time.Now().Add(-8*24*time.Hour))

	key := "avatars/" + orphanID + "/photo.jpg"
	if err := a.Deps.Storage.Put(ctx, key, strings.NewReader("jpeg-ish"), 8, "image/jpeg"); err != nil {
		t.Fatal(err)
	}
	if err := a.Deps.Q.SetUserAvatar(ctx, dbgen.SetUserAvatarParams{ID: orphanID, AvatarKey: &key}); err != nil {
		t.Fatal(err)
	}

	if _, err := jobs.PurgeOrphanUsers(ctx, depsFor(a), time.Now()); err != nil {
		t.Fatalf("PurgeOrphanUsers: %v", err)
	}
	if _, found, _ := a.Deps.Storage.GetStream(ctx, key); found {
		t.Errorf("avatar object survived the orphan purge")
	}
}
```
Add `"strings"` and `dbgen "github.com/refsdal/pjokk/server/internal/db/gen"` to that file's imports.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/server && go test -p 1 ./internal/api -run TestDeleteAdminUserRemovesTheAvatarObject 2>&1 | tail -5; go test -p 1 ./internal/jobs -run TestPurgeOrphanUsersRemovesTheAvatarObject 2>&1 | tail -5
```
Expected: both FAIL on "survived".

- [ ] **Step 3: Implement**

In `admin.go`'s `DeleteAdminUser`, right after the `GetAdminUser` switch (before `RevokeImpersonatedSessions`):
```go
	// Read the avatar key before the row goes; the object is deleted after
	// the commit (a delete that rolls back must keep the photo).
	profile, err := d.Q.GetUserProfile(ctx, req.Id)
	if err != nil {
		return nil, err
	}
```
and after `tx.Commit` succeeds, before the return:
```go
	if profile.AvatarKey != nil {
		if err := d.Storage.Delete(ctx, *profile.AvatarKey); err != nil {
			log.Printf("api: delete avatar of removed user %s: %v", req.Id, err)
		}
	}
```
Add `"log"` to the imports if missing.

In `jobs/purge.go`'s loop, before `d.Q.DeleteOrphanUser(ctx, id)`:
```go
		profile, err := d.Q.GetUserProfile(ctx, id)
		if err != nil {
			return purged, fmt.Errorf("jobs: read orphan profile %s: %w", id, err)
		}
```
and after a successful delete (inside the loop, after `purged++` or wherever the success path is):
```go
		if profile.AvatarKey != nil {
			if err := d.Storage.Delete(ctx, *profile.AvatarKey); err != nil {
				log.Printf("purge: delete avatar of orphan %s: %v", id, err)
			}
		}
```
Read the loop first: `PurgeOrphanUsers` swallows FK-blocked deletes (its third test) — put the object delete only on the path where the row was actually removed.

- [ ] **Step 4: Run, then full suite, then commit**

```bash
cd apps/server && go test -p 1 ./internal/api -run 'TestDeleteAdminUser' -v 2>&1 | tail -8; go test -p 1 ./internal/jobs -v -run TestPurgeOrphan 2>&1 | tail -12; go test -p 1 ./... 2>&1 | tail -30
git add apps/server
git commit -m "feat(api): drop the avatar object with the account, on admin delete and orphan purge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 6: Frontend — `Avatar` component and where it renders

**Files:**
- Modify: `packages/shared/src/schemas.ts` (`MemberSchema`)
- Create: `apps/frontend/src/components/Avatar.tsx`
- Modify: `apps/frontend/src/lib/data/family.ts` (`useMemberAvatars`), `apps/frontend/src/components/Chips.tsx`, `apps/frontend/src/screens/Home.tsx`, `apps/frontend/src/screens/Timeline.tsx`, `apps/frontend/src/screens/settings/FamilySection.tsx`, `apps/frontend/src/components/sheets/EventSheet.tsx`
- Test: `apps/frontend/test/avatar.test.tsx`

**Interfaces:**
- Consumes: `Me.avatarUrl`, `Me.displayName`, `Member.avatarUrl` from the generated schema (Task 2).
- Produces: `Avatar({ src, name, size, className })` with `size: 5 | 8 | 9 | 11 | 20`; `initialOf(name: string): string`; `useMemberAvatars(): Record<string, string | null>`; `MultiChipGroup` option `leading?: ReactNode`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/test/avatar.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, initialOf } from "../src/components/Avatar";

// No DOM in this suite (see router.test.ts), so the component is checked
// through static markup: with a src it is an <img>, without one it is the
// initial. The onError fallback needs a browser and is covered by the
// Playwright spec (an offline image falls back to the initial).
describe("Avatar", () => {
  it("renders the photo when there is one", () => {
    const html = renderToStaticMarkup(
      <Avatar src="/api/users/u1/avatar?v=k.jpg" name="Anders" size={8} />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="/api/users/u1/avatar?v=k.jpg"');
  });

  it("falls back to the initial without a photo", () => {
    const html = renderToStaticMarkup(<Avatar src={null} name="anders" size={8} />);
    expect(html).not.toContain("<img");
    expect(html).toContain(">A<");
  });
});

describe("initialOf", () => {
  it("upper-cases the first letter and copes with blanks", () => {
    expect(initialOf("pappa")).toBe("P");
    expect(initialOf("  Liv ")).toBe("L");
    expect(initialOf("")).toBe("?");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test apps/frontend/test/avatar.test.tsx 2>&1 | tail -6
```
Expected: FAIL — cannot resolve `../src/components/Avatar`.

- [ ] **Step 3: Implement the component**

Create `apps/frontend/src/components/Avatar.tsx`:

```tsx
import { useState } from "react";
import { cn } from "@/lib/utils";

// One face, everywhere a person is shown (spec §4): the Home chip, the
// Caretakers list, the far right of a timeline row, the assignee chips in
// the event sheet, the account sheet and the profile screen.
//
// Falls back to the initial when there is no photo AND when the photo fails
// to load — offline with the image not in the service-worker cache looks
// exactly like "no photo", which is the calm default.
const sizes = {
  5: "h-5 w-5 text-[9px]",
  8: "h-8 w-8 text-xs",
  9: "h-9 w-9 text-sm",
  11: "h-11 w-11 text-base",
  20: "h-20 w-20 text-2xl",
} as const;

export type AvatarSize = keyof typeof sizes;

export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function Avatar({
  src,
  name,
  size,
  className,
}: {
  src: string | null | undefined;
  name: string;
  size: AvatarSize;
  className?: string;
}) {
  // Remember WHICH src failed, so a new upload (a new URL) gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!src && failed !== src;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft font-bold text-accent",
        sizes[size],
        className,
      )}
      title={name}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}
```

- [ ] **Step 4: Run the test**

```bash
bun test apps/frontend/test/avatar.test.tsx 2>&1 | tail -6
```
Expected: 3 pass.

- [ ] **Step 5: Shared type, avatar map, chips**

`packages/shared/src/schemas.ts` — in `MemberSchema` replace `image: z.string().nullable(),` with:
```ts
  // "/api/users/{userId}/avatar?v=…" or null; see components/Avatar.tsx.
  avatarUrl: z.string().nullable(),
```

`apps/frontend/src/lib/data/family.ts` — add `useMemo` to the React import (`import { useMemo } from "react";`) and append:
```ts
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
```

`apps/frontend/src/components/Chips.tsx` — in `MultiChipGroup`: the options type becomes `{ value: T; label: ReactNode; leading?: ReactNode }[]`, the button's className gains `inline-flex items-center gap-2` and, if the option has `leading`, it is rendered before the label with a negative left margin so the face sits flush at the chip's edge:
```tsx
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(opt.value)}
            className={cn(
              "inline-flex h-11 min-w-16 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors select-none active:scale-[0.97]",
              opt.leading && "pl-2",
              active
                ? "border-accent bg-accent text-on-accent"
                : "border-line bg-surface text-ink-soft",
            )}
          >
            {opt.leading}
            {opt.label}
          </button>
```

- [ ] **Step 6: Render it in the four places**

`screens/Home.tsx` — add `import { Avatar } from "@/components/Avatar";` and replace the header's `<div className="flex h-11 w-11 …">…</div>` with:
```tsx
        <Avatar
          src={me.data?.avatarUrl}
          name={me.data?.displayName ?? "?"}
          size={11}
        />
```
(Task 8 wraps this in the account-sheet button.)

`screens/settings/FamilySection.tsx` — import `Avatar`; replace the member row's initial `<div className="flex h-9 w-9 …">…</div>` with:
```tsx
              <Avatar src={m.avatarUrl} name={m.name} size={9} />
```

`screens/Timeline.tsx` — import `Avatar` and `useMemberAvatars` (from `@/lib/data`). `Row` gains a prop `avatarUrl: string | null | undefined`; after the closing `</span>` of the clock/author block, add the face at the far right spanning both lines:
```tsx
      <Avatar src={avatarUrl} name={entry.caretakerName} size={8} />
```
In `TimelineScreen`, `const avatars = useMemberAvatars();` and every `<Row entry={entry} …/>` gets `avatarUrl={avatars[entry.caretakerId]}`.

`components/sheets/EventSheet.tsx` — import `Avatar`; the Responsible chips become:
```tsx
            options={(members.data ?? []).map((m) => ({
              value: m.userId,
              label: m.name,
              leading: <Avatar src={m.avatarUrl} name={m.name} size={5} />,
            }))}
```

- [ ] **Step 7: Check and build**

```bash
bun run check 2>&1 | tail -15 && bun run build:client 2>&1 | tail -5
```
Expected: clean. If biome reorders imports, run `bun run lint:fix`.

- [ ] **Step 8: Commit**

```bash
git add packages/shared apps/frontend
git commit -m "feat(frontend): Avatar component, rendered on Home, Caretakers, timeline rows and assignee chips

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 7: Frontend — the `/profile` screen

**Files:**
- Create: `apps/frontend/src/lib/data/profile.ts`, `apps/frontend/src/lib/avatar-image.ts`, `apps/frontend/src/screens/Profile.tsx`
- Modify: `apps/frontend/src/lib/data/index.ts`, `apps/frontend/src/router.tsx`, `apps/frontend/src/screens/settings/index.tsx`, `apps/frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `Avatar` (Task 6); `client`, `unwrap`, `API_BASE` (`lib/api.ts`); `useMe` + `Me` (`lib/data/family.ts`); `invalidateLogs` (`lib/data/keys.ts`); `toast`; `Sheet`-free plain page layout like `SettingsScreen`.
- Produces: `useUpdateMe()`, `useUploadAvatar()`, `useDeleteAvatar()` mutations resolving to `Me`; `prepareAvatar(file: Blob, size?: number): Promise<Blob>`; route `/profile` → `ProfileScreen`.

- [ ] **Step 1: Data hooks**

Create `apps/frontend/src/lib/data/profile.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_BASE, client, unwrap } from "../api";
import type { Me } from "./family";
import { invalidateLogs } from "./keys";

// The caller's own profile (spec §4/§5). Every write returns the fresh Me,
// which replaces the cached one directly; members and every log view are
// invalidated because they show this person's name and face.

export interface UpdateMeVars {
  name?: string;
  nickname?: string | null;
  phone?: string | null;
}

function useProfileMutation<V>(fn: (vars: V) => Promise<Me>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (me) => {
      qc.setQueryData(["me"], me);
      void qc.invalidateQueries({ queryKey: ["members"] });
      invalidateLogs(qc);
    },
  });
}

export function useUpdateMe() {
  return useProfileMutation((vars: UpdateMeVars) =>
    unwrap<Me>(client.PATCH("/api/me", { body: vars })),
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
  });
}

export function useDeleteAvatar() {
  return useProfileMutation(async () =>
    unwrap<Me>(
      await fetch(`${API_BASE}/api/me/avatar`, {
        method: "DELETE",
        credentials: "include",
      }),
    ),
  );
}
```
Check `invalidateLogs`'s exact export name in `lib/data/keys.ts` (it is `export const invalidateLogs = (qc: QueryClient) => …`). Add `export * from "./profile";` to `lib/data/index.ts`.

- [ ] **Step 2: On-device crop and resize**

Create `apps/frontend/src/lib/avatar-image.ts`:

```ts
// Centre-crop to a square and resize on the device before upload (spec §4):
// the server accepts at most 512 KB / 1024 px and never sees the original.
// A canvas export carries no EXIF, so nothing the camera embedded (a GPS
// fix, most of all) leaves the phone — the server strips again regardless.
//
// Decoding goes through an <img> rather than createImageBitmap: Safari
// decodes HEIC for <img> and applies EXIF orientation there, which is the
// path an iPhone photo needs.

export const AVATAR_SIZE = 512;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

export async function prepareAvatar(
  file: Blob,
  size = AVATAR_SIZE,
): Promise<Blob> {
  const img = await loadImage(file);
  const edge = Math.min(img.naturalWidth, img.naturalHeight);
  if (edge <= 0) throw new Error("Could not read that image");
  const sx = (img.naturalWidth - edge) / 2;
  const sy = (img.naturalHeight - edge) / 2;
  const out = Math.min(size, edge);

  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not read that image");
  ctx.drawImage(img, sx, sy, edge, edge, 0, 0, out, out);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not read that image")),
      "image/jpeg",
      0.85,
    );
  });
}
```

- [ ] **Step 3: The screen**

Create `apps/frontend/src/screens/Profile.tsx`:

```tsx
import { IconChevronLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { prepareAvatar } from "@/lib/avatar-image";
import {
  useDeleteAvatar,
  useMe,
  useUpdateMe,
  useUploadAvatar,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./settings/lib";

// /profile — the person, as opposed to Settings, which is the family and the
// device (spec §4). Global: the same nickname and photo in every family.
export function ProfileScreen() {
  const me = useMe();
  const updateMe = useUpdateMe();
  const upload = useUploadAvatar();
  const removeAvatar = useDeleteAvatar();
  const fileInput = useRef<HTMLInputElement>(null);

  // Plain state, seeded once from the server (BabySheet's pattern).
  const [seeded, setSeeded] = useState(false);
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  if (me.data && !seeded) {
    setSeeded(true);
    setName(me.data.name);
    setNickname(me.data.nickname ?? "");
    setPhone(me.data.phone ?? "");
  }

  if (me.isPending) return <LoadingState />;
  if (me.isError || !me.data) return <ErrorState />;
  const profile = me.data;

  const save = () => {
    if (!name.trim()) {
      toast(t("Name cannot be blank"), "error");
      return;
    }
    updateMe.mutate(
      {
        name: name.trim(),
        nickname: nickname.trim() || null,
        phone: phone.trim() || null,
      },
      {
        onSuccess: () => toast(t("Profile saved")),
        onError: (err) => toast(err.message, "error"),
      },
    );
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const blob = await prepareAvatar(file);
      upload.mutate(blob, {
        onSuccess: () => toast(t("Photo updated")),
        onError: (err) => toast(err.message, "error"),
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Could not read that image"), "error");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const busy = updateMe.isPending || upload.isPending || removeAvatar.isPending;

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      <div className="flex items-center gap-2 py-4">
        <Link
          to="/settings"
          aria-label={t("Back")}
          className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
        >
          <IconChevronLeft className="h-6 w-6" />
        </Link>
        <h1 className="text-2xl font-extrabold text-ink">{t("Your profile")}</h1>
      </div>

      <div className="space-y-3 pb-tabbar">
        <Card className="flex flex-col items-center gap-3">
          <Avatar src={profile.avatarUrl} name={profile.displayName} size={20} />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={t("Change photo")}
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {t("Change photo")}
            </Button>
            {profile.avatarUrl && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  removeAvatar.mutate(undefined, {
                    onSuccess: () => toast(t("Photo removed")),
                    onError: (err) => toast(err.message, "error"),
                  })
                }
              >
                {t("Remove photo")}
              </Button>
            )}
          </div>
        </Card>

        <SectionTitle>{t("About you")}</SectionTitle>
        <Card className="space-y-4">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-muted">{t("Full name")}</span>
            <Input
              aria-label={t("Full name")}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-muted">{t("Nickname")}</span>
            <Input
              aria-label={t("Nickname")}
              value={nickname}
              maxLength={40}
              onChange={(e) => setNickname(e.target.value)}
            />
            <span className="block text-xs text-muted">
              {t("Shown instead of your full name everywhere")}
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-muted">{t("Phone")}</span>
            <Input
              aria-label={t("Phone")}
              type="tel"
              inputMode="tel"
              value={phone}
              maxLength={32}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <div className="space-y-1">
            <span className="text-xs font-semibold text-muted">{t("Email")}</span>
            <p className="text-base text-ink">{profile.email}</p>
            <span className="block text-xs text-muted">{t("Sign-in address")}</span>
          </div>
          <Button size="full" disabled={busy} onClick={save}>
            {t("Save")}
          </Button>
        </Card>
      </div>
    </div>
  );
}
```
If `QueryStates` exports different names, check `components/QueryStates.tsx` and use what it exports.

- [ ] **Step 4: Route and Settings row**

`router.tsx` — import `ProfileScreen` and add under `settingsRoute`:
```tsx
// The person, not the family: reached from the account sheet on Home and
// from Settings → Account.
const profileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profile",
  component: ProfileScreen,
});
```
and add `profileRoute` to `appRoute.addChildren([...])` after `settingsRoute`.

`screens/settings/index.tsx` — import `Avatar` and `IconChevronRight` from `@tabler/icons-react`; in the Account card replace the `<p className="text-sm text-ink-soft">…</p>` block with:
```tsx
          <Link
            to="/profile"
            className="flex min-h-14 items-center gap-3 rounded-xl2 border border-line px-4 py-2 active:bg-surface-2"
          >
            <Avatar
              src={me.data?.avatarUrl}
              name={me.data?.displayName ?? "?"}
              size={9}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-ink">
                {me.data?.displayName}
              </span>
              <span className="block truncate text-xs text-muted">
                {me.data?.email}
              </span>
            </span>
            <IconChevronRight className="h-5 w-5 text-muted" />
          </Link>
```

- [ ] **Step 5: i18n**

In `lib/i18n.ts`'s `nb` dictionary add a `// Profile` block (skip any key that already exists — `node scripts/check-i18n.mjs` reports duplicates and misses):
```ts
  // Profile
  "Your profile": "Din profil",
  "About you": "Om deg",
  "Full name": "Fullt navn",
  Nickname: "Kallenavn",
  "Shown instead of your full name everywhere": "Vises i stedet for fullt navn overalt",
  Phone: "Telefon",
  Email: "E-post",
  "Sign-in address": "Innloggingsadresse",
  "Change photo": "Bytt bilde",
  "Remove photo": "Fjern bilde",
  "Photo updated": "Bilde oppdatert",
  "Photo removed": "Bilde fjernet",
  "Profile saved": "Profil lagret",
  "Name cannot be blank": "Navn kan ikke være tomt",
  "Could not read that image": "Kunne ikke lese bildet",
  Back: "Tilbake",
```

- [ ] **Step 6: Check, build, commit**

```bash
bun run check 2>&1 | tail -15 && bun run build:client 2>&1 | tail -5
git add apps/frontend
git commit -m "feat(frontend): /profile screen — name, nickname, phone, photo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 8: Frontend — family fence, account sheet, family switch

**Files:**
- Create: `apps/frontend/src/lib/family-fence.ts`, `apps/frontend/src/components/sheets/AccountSheet.tsx`
- Modify: `apps/frontend/src/lib/query.ts`, `apps/frontend/src/lib/selected-baby.ts`, `apps/frontend/src/screens/shell.tsx`, `apps/frontend/src/screens/Home.tsx`, `apps/frontend/src/lib/i18n.ts`
- Test: `apps/frontend/test/family-fence.test.ts`

**Interfaces:**
- Consumes: `authClient.organization.list()` → `Page<Organization>` (`.items[].id/.name`), `authClient.organization.switch({ id })`; `resetCache()`; `signOut()`; `Sheet`; `Avatar`.
- Produces: `judgeFamily(stored: string | null, current: string | null): "recorded" | "same" | "changed"`; `readFence()`, `writeFence(id)`, `clearFence()`; `clearSelectedBaby()`; `AccountSheet({ open, onOpenChange })`.

- [ ] **Step 1: Write the failing fence test**

Create `apps/frontend/test/family-fence.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { judgeFamily } from "../src/lib/family-fence";

// The fence is the one guard the switch flow cannot provide: it compares
// the family the app last rendered with what /api/me says now, so a switch
// made in another tab, on another device, or interrupted mid-way is caught
// on the next resolve (spec §5).
describe("judgeFamily", () => {
  it("records the first family it sees", () => {
    expect(judgeFamily(null, "fam-1")).toBe("recorded");
  });
  it("is quiet while the family is unchanged", () => {
    expect(judgeFamily("fam-1", "fam-1")).toBe("same");
  });
  it("flags a different family", () => {
    expect(judgeFamily("fam-1", "fam-2")).toBe("changed");
  });
  it("ignores a session with no family yet (the Welcome flow)", () => {
    expect(judgeFamily(null, null)).toBe("same");
    expect(judgeFamily("fam-1", null)).toBe("same");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test apps/frontend/test/family-fence.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement the fence and the baby clear**

Create `apps/frontend/src/lib/family-fence.ts`:

```ts
// Family fence (spec §5). The server keeps the active family on the
// session; the client keeps caches keyed without one. Whenever the family
// behind the session changes without this tab's switch flow running —
// another tab, another device, a crash mid-switch — the cache must go. The
// shell compares what /api/me reports with the last family this device
// rendered, and resets on a mismatch.

const KEY = "pjokk.familyId";

export type FenceVerdict = "recorded" | "same" | "changed";

export function judgeFamily(
  stored: string | null,
  current: string | null,
): FenceVerdict {
  // No family yet (Welcome) — nothing to fence, and nothing to forget.
  if (current === null) return "same";
  if (stored === null) return "recorded";
  return stored === current ? "same" : "changed";
}

export function readFence(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeFence(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable
  }
}

export function clearFence(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}
```

`lib/query.ts` — import `clearFence` and add to `resetCache()` before `queryClient.clear()`:
```ts
  // The fence describes the cache being dropped; a fresh identity records
  // its own family on the next /api/me.
  clearFence();
```
Also add `"my-families"` to `NEVER_PERSIST` (the account sheet's list is identity, not content).

`lib/selected-baby.ts` — add:
```ts
// Forget the device's baby selection — a family switch leaves it pointing
// at a baby the new family does not have (it would self-heal to the first
// baby anyway; clearing keeps the reasoning simple).
export function clearSelectedBaby() {
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
  for (const fn of listeners) fn();
}
```

- [ ] **Step 4: Wire the fence into the shell**

`screens/shell.tsx` — import `useEffect` from react and the fence helpers. Before the early returns (hooks first):
```tsx
  const familyId = me.data?.familyId ?? null;
  // Family fence (lib/family-fence.ts): a mismatch means the family behind
  // this session changed outside this tab's switch flow.
  useEffect(() => {
    const verdict = judgeFamily(readFence(), familyId);
    if (verdict === "recorded") writeFence(familyId as string);
    if (verdict === "changed") {
      void resetCache().then(() => window.location.reload());
    }
  }, [familyId]);
```

- [ ] **Step 5: The account sheet**

Create `apps/frontend/src/components/sheets/AccountSheet.tsx`:

```tsx
import { IconCheck } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { authClient, signOut } from "@/lib/auth-client";
import { useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { resetCache } from "@/lib/query";
import { clearSelectedBaby } from "@/lib/selected-baby";
import { toast } from "@/lib/toast";

// Opens from the avatar chip on Home (CLAUDE.md IA: "caretaker chip (avatar
// → family switcher)"): the person, their families, and the way out.
export function AccountSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  // Limen's own list route (allowlisted server-side). Never persisted.
  const families = useQuery({
    queryKey: ["my-families"],
    enabled: open,
    queryFn: async () => (await authClient.organization.list()).items,
  });

  const switchTo = async (id: string) => {
    if (id === me.data?.familyId) {
      onOpenChange(false);
      return;
    }
    // Queued offline writes carry THIS family's baby ids; replayed after a
    // switch the server would reject them under tenancy and the entry
    // would be lost. Refuse rather than lose a log.
    const paused = qc
      .getMutationCache()
      .getAll()
      .some((m) => m.state.isPaused);
    if (paused) {
      toast(t("Finish syncing before switching family"), "error");
      return;
    }
    setBusy(true);
    try {
      await authClient.organization.switch({ id });
      clearSelectedBaby();
      await resetCache();
      onOpenChange(false);
      void navigate({ to: "/home" });
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t("Could not switch family"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Account")}>
      <div className="space-y-4 pb-4">
        <Link
          to="/profile"
          onClick={() => onOpenChange(false)}
          className="flex min-h-14 items-center gap-3 rounded-xl2 border border-line px-4 py-2 active:bg-surface-2"
        >
          <Avatar
            src={me.data?.avatarUrl}
            name={me.data?.displayName ?? "?"}
            size={11}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-ink">
              {me.data?.displayName}
            </span>
            <span className="block truncate text-xs text-muted">
              {me.data?.email}
            </span>
          </span>
          <span className="text-sm font-semibold text-accent">
            {t("Your profile")}
          </span>
        </Link>

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Families")}
          </p>
          <div className="divide-y divide-line rounded-xl2 border border-line">
            {(families.data ?? []).map((f) => {
              const active = f.id === me.data?.familyId;
              return (
                <button
                  key={f.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void switchTo(f.id)}
                  className="flex min-h-12 w-full items-center gap-3 px-4 text-left active:bg-surface-2"
                >
                  <span className="flex-1 truncate font-semibold text-ink">
                    {f.name}
                  </span>
                  {active && <IconCheck className="h-5 w-5 text-accent" />}
                </button>
              );
            })}
            {families.isPending && (
              <p className="px-4 py-3 text-sm text-muted">{t("Loading…")}</p>
            )}
          </div>
        </div>

        <Button
          size="full"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void signOut().then(() => window.location.assign("/login"))
          }
        >
          {t("Sign out")}
        </Button>
      </div>
    </Sheet>
  );
}
```

`screens/Home.tsx` — add `"account"` to `OpenSheet`; import `AccountSheet`; wrap the header `Avatar` in a button:
```tsx
        <button
          type="button"
          aria-label={t("Account")}
          onClick={() => setSheet("account")}
          className="rounded-full active:scale-95"
        >
          <Avatar
            src={me.data?.avatarUrl}
            name={me.data?.displayName ?? "?"}
            size={11}
          />
        </button>
```
and next to `<HelpSheet …/>`:
```tsx
      <AccountSheet
        open={sheet === "account"}
        onOpenChange={(o) => setSheet(o ? "account" : null)}
      />
```
Note the night-mode early return in `HomeScreen` only preserves `feed`/`diaper`/`sleep` sheets; `account` is a day-mode sheet, and `NightHome` has no chip, so nothing else changes.

i18n additions:
```ts
  // Account sheet
  Account: "Konto",
  Families: "Familier",
  "Finish syncing before switching family": "Vent til alt er synkronisert før du bytter familie",
  "Could not switch family": "Kunne ikke bytte familie",
  "Loading…": "Laster…",
```
(Skip keys that already exist.)

- [ ] **Step 6: Tests, check, build, commit**

```bash
bun test apps/frontend 2>&1 | tail -6 && bun run check 2>&1 | tail -10 && bun run build:client 2>&1 | tail -5
git add apps/frontend
git commit -m "feat(frontend): account sheet with family switch, and a family fence on the shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 9: Playwright — profile, photo, account sheet

**Files:**
- Create: `e2e/profile.spec.ts`

**Interfaces:**
- Consumes: `freshFamily(page, request, tag)` (`e2e/helpers.ts`), `expectLoginScreen` if exported (else assert `/login` in the URL); the `aria-label`s from Task 7/8 (`Change photo`, `Account`).

- [ ] **Step 1: Write the spec**

Create `e2e/profile.spec.ts`:

```ts
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// A 1×1 red PNG — enough for the on-device crop/resize to produce a JPEG
// the server accepts.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

test("a nickname replaces the full name on timeline rows", async ({ page, request }) => {
  await freshFamily(page, request, "profile");

  await page.goto("/profile");
  await page.getByLabel("Full name").fill("Anders Olsen");
  await page.getByLabel("Nickname").fill("Pappa");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();

  await page.goto("/home");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/1 feeds/)).toBeVisible({ timeout: 10_000 });

  await page.goto("/timeline");
  await expect(page.getByText("by Pappa").first()).toBeVisible();
});

test("uploading a photo puts it on the Home chip", async ({ page, request }) => {
  await freshFamily(page, request, "photo");

  await page.goto("/profile");
  await page.getByLabel("Change photo").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG_1x1,
  });
  await expect(page.getByText("Photo updated")).toBeVisible({ timeout: 10_000 });

  await page.goto("/home");
  const chip = page.getByRole("button", { name: "Account" });
  await expect(chip.locator("img")).toBeVisible();

  await page.goto("/profile");
  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByText("Photo removed")).toBeVisible();
  await page.goto("/home");
  await expect(page.getByRole("button", { name: "Account" }).locator("img")).toHaveCount(0);
});

test("the account sheet lists the family and signs out", async ({ page, request }) => {
  await freshFamily(page, request, "account");

  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByText("The account family")).toBeVisible();
  await expect(page.getByText("Your profile")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});
```

- [ ] **Step 2: Run it against the e2e stack**

```bash
bash scripts/e2e-stack.sh up && cd e2e && bunx playwright test profile.spec.ts 2>&1 | tail -20; cd .. && bash scripts/e2e-stack.sh down
```
Read `scripts/e2e-stack.sh` first for the exact up/down verbs and whether it builds the image (it drives the real binary — the SPA must be rebuilt first, `bun run build:client`, if the script does not do it). Expected: 3 passed. If the timeline assertion is brittle on the "by" label, check `Timeline.tsx` renders `{t("by")} {entry.caretakerName}` as one text node — Playwright's `getByText("by Pappa")` matches the concatenated span content.

- [ ] **Step 3: Typecheck the e2e project and commit**

```bash
bun run typecheck 2>&1 | tail -5
git add e2e/profile.spec.ts
git commit -m "test(e2e): profile nickname, photo upload, account sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (IA section), `DECISIONS.md` (new entry at the end)

- [ ] **Step 1: CLAUDE.md**

In the "Information architecture" list, change the Home bullet's chip clause to:
```
- **Home:** baby header w/ age + caretaker chip (the user's avatar → account
  sheet: profile, family switcher, sign out), active-session banner …
```
and add a bullet after **Settings:**
```
- **Profile (`/profile`):** the person, not the family — full name,
  nickname (shown instead of the name everywhere, via the users
  `display_name` generated column), phone (private), photo. Reached from the
  account sheet and Settings → Account. Global across families.
```
In "Product principles" §8 append: "Attribution uses the display name (nickname, else full name) and the caretaker's avatar."

- [ ] **Step 2: DECISIONS.md**

Append:

```markdown
## User profile, avatars, and no family in the URL (2026-09-06)

- **`display_name` is a stored generated column** — nickname when set, else
  the full name. Every join that shows a person to their family reads it
  (logs, timeline, summary, CSV export, members, calendar). The session's
  own name, the admin audit trail and the API-key join keep the full name.
  Neither the handlers nor the SPA know the rule.
- **The login email is shown, not edited, and there is no contact email.**
  Limen's `users.email` is NOT NULL, UNIQUE and the credential subject;
  every account today has a real address. A nullable `contact_email` is a
  one-column change if a provider without email ever ships. Deferred, not
  rejected.
- **Phone is private.** Not on `Member`, not in the Caretakers list, not on
  the help card. A "share with my families" toggle is the natural way to
  open that later.
- **Avatars go through the storage port and are re-encoded server-side to
  JPEG.** Proves the bytes are an image whatever the declared type, bounds
  the pixel count from the header before decoding, and strips EXIF (no GPS
  fix reaches the store). They are outside the nightly row dump, like
  vaccine documents. Served only through `/api/users/{id}/avatar`, to the
  owner and to co-members; everyone else gets 404, never 403.
- **The Google picture is imported once**, on the first `GET /api/me`,
  synchronously with a 3 s cap, host-allowlisted to googleusercontent.com.
  The attempt is marked whatever happens, so a removed photo never comes
  back on the next Google sign-in.
- **No family slug in the URL.** The server resolves the family from the
  session and scopes every query; the client never names one. A URL family
  would be a second source of truth (tabs disagree, a switch per
  navigation, PWA start URL / precache / push links / `/join/CODE` all
  harder) for a switch that happens rarely. The client-side hazards — stale
  family-level caches, replayed offline writes, a second tab — are handled
  by the switch flow (refuse with paused mutations, then `resetCache`) and
  the family fence in the shell (`localStorage` family id vs `/api/me`,
  reset + reload on mismatch).
- **Nothing else moved out of Settings.** Notifications are per user but
  configured per device; Appearance is per device.
```

- [ ] **Step 3: Commit, then final verification**

```bash
git add CLAUDE.md DECISIONS.md
git commit -m "docs: profile, avatars and the account sheet in CLAUDE.md and DECISIONS.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN"

cd apps/server && go vet ./... && go test -p 1 ./... 2>&1 | tail -30 && cd ../.. && bun run check 2>&1 | tail -8 && bun run test 2>&1 | tail -8
```
Expected: every Go package `ok`, `bun run check` clean, frontend + landing tests green. Then open a PR from `feat/user-profile` to `main` (the user decides on merge).
