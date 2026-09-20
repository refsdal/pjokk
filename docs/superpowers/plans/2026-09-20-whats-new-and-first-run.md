# What's New and First Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A returning caretaker learns what changed through one dismissible
line at the foot of Home; a caretaker arriving for the first time gets a
full-screen paced carousel, once.

**Architecture:** Two new columns on `users` (`onboarded_at`,
`whats_new_seq`) carried by the existing `GET`/`PATCH /api/me` pair — no new
endpoints. Release entries are bundled in the SPA on a monotonic integer
`seq`, filtered by a pure selector against the family's enabled
`baby.features`. Two presentations: a list at `/whats-new` for returning
users, and a carousel at `/getting-started` for first run, the latter reusing
a generic `Carousel` lifted out of `TrackingCarousel`.

**Tech Stack:** Go 1.27 + pgx/sqlc/goose, hand-written OpenAPI →
oapi-codegen strict server + `openapi-typescript` client, React + TanStack
Router/Query, Tailwind, `bun:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md`

**Issue:** #140 · **PR:** #141 · **Branch:** `feat/whats-new`

## Global Constraints

- **Every user-facing string goes through `t()`** and needs an entry in the
  `nb` dictionary at the top of `apps/frontend/src/lib/i18n.ts`, keyed by
  the English string. `bun run check` runs `scripts/check-i18n.mjs` and
  exits 1 listing any missing key. `screens/admin/**` is exempt; nothing
  here is under that path.
- **`openapi/pjokk.yaml` is the single source of truth.** After editing it,
  run `go generate ./...` from `apps/server` (which copies it to
  `internal/api/pjokk.yaml` and runs oapi-codegen twice) and
  `bun run gen:client` from the repo root. `spec_sync_test.go` fails if the
  copy drifts. Never hand-edit `apps/server/internal/api/pjokk.yaml`.
- **Generated files are committed**: `apps/server/internal/api/gen/*`,
  `apps/server/internal/db/gen/*`, `packages/shared/src/api-schema.d.ts`.
  The last is excluded from biome — do not reformat it.
- **`seq` is append-only.** Never reorder, never reuse, never renumber.
- **Go and sqlc may be off `PATH`**: `export PATH="$PATH:$HOME/.local/go/bin:$HOME/go/bin"`.
- **A real Postgres is required** for the Go suite:
  `docker compose -f docker-compose.test.yml up -d` (publishes 55432).
- **Never run the Go suite while an e2e stack is rebuilding** — they race on
  `internal/web/dist`.
- **Commit style:** Conventional Commits. Body references `Issue #140`.
  Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

### Verification commands

| What | Command (from repo root unless noted) |
|---|---|
| Go tests | `cd apps/server && go test ./...` |
| Go vet | `cd apps/server && go vet ./...` |
| Frontend + landing unit tests | `bun run test` |
| Lint + i18n + typecheck | `bun run check` |
| One frontend test file | `bun test apps/frontend/test/whats-new.test.ts` |
| One e2e spec | `bunx playwright test e2e/whats-new.spec.ts --config e2e/playwright.config.ts` |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/server/internal/db/migrations/00034_user_whats_new.sql` | The two columns and the `onboarded_at` backfill |
| `apps/server/internal/api/me_whats_new_test.go` | `GREATEST` guard, round-trips, migration backfill |
| `apps/frontend/src/data/whats-new.ts` | The entries themselves — content, not logic |
| `apps/frontend/src/lib/whats-new.ts` | Pure selection: `pending`, `highestSeq` |
| `apps/frontend/test/whats-new.test.ts` | Unit tests for the selector |
| `apps/frontend/src/components/Carousel.tsx` | Generic snap strip + dots + Back/Next/Done |
| `apps/frontend/src/components/WhatsNewLine.tsx` | The dismissible row on Home |
| `apps/frontend/src/screens/WhatsNew.tsx` | The list at `/whats-new` |
| `apps/frontend/src/screens/GettingStarted.tsx` | The first-run carousel |
| `e2e/whats-new.spec.ts` | Row, dismissal, persistence, night mode, list |

**Modified**

| File | Change |
|---|---|
| `apps/server/internal/db/queries/profile.sql` | Select the two columns; write them in `UpdateUserProfile` |
| `openapi/pjokk.yaml` | `Me` + `UpdateMe` gain `onboarded`, `whatsNewSeq` |
| `apps/server/internal/api/me.go` | Read/validate the two fields; map into `gen.Me` |
| `apps/frontend/src/lib/data/profile.ts` | `UpdateMeVars` gains the two fields |
| `apps/frontend/src/components/tracking/TrackingCarousel.tsx` | Render through `Carousel` |
| `apps/frontend/src/screens/Home.tsx` | Render `<WhatsNewLine />` in the actions column, below `<HomeActions>` |
| `apps/frontend/src/screens/shell.tsx` | `AppChrome` redirects when `onboarded === false` |
| `apps/frontend/src/screens/Welcome.tsx` | Sets `onboarded: true` for founders |
| `apps/frontend/src/router.tsx` | `whatsNewRoute`, `gettingStartedRoute` |
| `apps/frontend/src/screens/Profile.tsx` | Two rows: What's new, Getting started |
| `apps/frontend/src/screens/settings/index.tsx` | Version string becomes a link |
| `apps/frontend/src/lib/i18n.ts` | `nb` entries for every new string |
| `e2e/helpers.ts` | `skipGettingStarted`; call it from `uiCreateFamily` |
| `e2e/invite.spec.ts` | Invitees now land on `/getting-started` first |

### One deliberate deviation from the spec

The spec's selector signature takes `enabled: Set<Feature>`. The codebase
already has `familyTracks(babies, key)` in `apps/frontend/src/lib/tracking.ts`,
used by `FamilyPage.tsx` for exactly this union, so `pending` takes a
**predicate** `(key: Feature) => boolean` instead and callers pass
`(k) => familyTracks(babies.data, k)`. Same behaviour, one fewer concept, and
it inherits `familyTracks`' "babies still loading → true" guard for free.

---

## Task 1: Schema — the two columns

**Files:**
- Create: `apps/server/internal/db/migrations/00034_user_whats_new.sql`
- Modify: `apps/server/internal/db/queries/profile.sql`
- Modify (generated, committed): `apps/server/internal/db/gen/*`

No test file: see Step 2.

**Interfaces:**
- Consumes: nothing.
- Produces: `dbgen.GetUserProfileRow` gains `OnboardedAt pgtype.Timestamptz`
  (**not** `*time.Time` — it follows the sibling `AvatarImportedAt` in the
  same generated file, so read it as `.Valid` / `.Time`, never a nil check)
  and `WhatsNewSeq int32`; `dbgen.UpdateUserProfileParams` gains
  `Onboarded *bool` and `WhatsNewSeq *int32`.

- [ ] **Step 1: Write the migration**

Create `apps/server/internal/db/migrations/00034_user_whats_new.sql`:

```sql
-- +goose Up

-- What's new, and a first run (spec
-- docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md).
-- Two columns because they answer two different questions: has this person
-- ever been oriented, and how far through the release notes are they.
--
-- Both are the PERSON's, like units (00013) and language (00018): dismiss
-- on the phone and the tablet stays quiet.
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamptz;
ALTER TABLE "users" ADD COLUMN "whats_new_seq" integer NOT NULL DEFAULT 0;

-- Every account that exists today has been using the app for weeks: mark it
-- onboarded so nobody is handed a getting-started tour retroactively. The
-- mirror of 00033's backfill, which kept every existing baby's switches on.
UPDATE "users" SET "onboarded_at" = "created_at";

-- whats_new_seq needs no backfill, and that is not an oversight: the SPA
-- ships no entry older than this migration (spec, "No backlog"), so an
-- existing account has seen nothing because there is nothing to have seen.

-- +goose Down
ALTER TABLE "users" DROP COLUMN "whats_new_seq";
ALTER TABLE "users" DROP COLUMN "onboarded_at";
```

- [ ] **Step 2: Note why this task ships no test of its own**

**Controller ruling (pre-flight scan).** This task adds no test file. The
API-level test belongs to Task 2, where it can pass; leaving a red test
committed here would make Task 1's commit red on CI.

Task 1 is verified by two things instead: `sqlc generate` succeeding against
the new schema, and the **existing** suite still passing. Every
database-backed test in this repo migrates to head, so the migration is
exercised broadly by the whole suite the moment it exists.

The spec's "a row created before `00034` comes out with
`onboarded_at = created_at`" assertion is deliberately **not** implemented:
`apps/server/internal/db/migrate_test.go` has no partial-migration harness
(it only migrates to head), and the backfill is an unconditional `UPDATE`
with no branching. Do not build a harness for it as part of this task.

- [ ] **Step 3: Confirm the starting state is green**

```bash
export PATH="$PATH:$HOME/.local/go/bin:$HOME/go/bin"
docker compose -f docker-compose.test.yml up -d
cd apps/server && go test ./... ; echo "exit=$?"
```

Expected: exit 0. You cannot tell whether your migration broke something if
the suite was already red.

- [ ] **Step 4: Add the columns to the read query**

In `apps/server/internal/db/queries/profile.sql`, extend `GetUserProfile`'s
select list — after `"image"`, before the `FROM`:

```sql
    "image",
    "onboarded_at",
    "whats_new_seq"
FROM "users"
WHERE "id" = $1;
```

- [ ] **Step 5: Add the columns to the write query**

Replace `UpdateUserProfile` in the same file with:

```sql
-- name: UpdateUserProfile :exec
-- Full-row write of the profile fields; the handler resolves the PATCH
-- tri-state (absent / null / value) before calling this. Three exceptions
-- take sqlc.narg so a caller that knows nothing of them cannot overwrite a
-- stored choice:
--
--   * the two language columns (00018): NULL leaves them as they are.
--   * whats_new_seq (00034): GREATEST, never a plain assignment. Mutations
--     queue offline and replay later, and a dismissal made on Tuesday and
--     replayed on Thursday must not walk the marker backwards and re-show
--     entries the person already dismissed.
--
-- onboarded_at is a CASE rather than a COALESCE because it has three wire
-- states (absent / true / false) mapping to three outcomes (leave alone /
-- set / clear), and COALESCE collapses two of them. Setting it uses
-- coalesce(onboarded_at, now()) so re-running the tour from Settings does
-- not rewrite the date this person actually first set the app up.
UPDATE "users"
SET "name" = @name, "nickname" = @nickname, "phone" = @phone, "units" = @units,
    "language_mode" = COALESCE(sqlc.narg('language_mode'), "language_mode"),
    "language" = COALESCE(sqlc.narg('language'), "language"),
    "whats_new_seq" = GREATEST("whats_new_seq", COALESCE(sqlc.narg('whats_new_seq')::int, "whats_new_seq")),
    "onboarded_at" = CASE
      WHEN sqlc.narg('onboarded')::bool IS NULL THEN "onboarded_at"
      WHEN sqlc.narg('onboarded')::bool         THEN COALESCE("onboarded_at", now())
      ELSE NULL
    END,
    "updated_at" = now()
WHERE "id" = @id;
```

- [ ] **Step 6: Regenerate sqlc**

```bash
export PATH="$PATH:$HOME/.local/go/bin:$HOME/go/bin"
cd apps/server && sqlc generate
git diff --stat internal/db/gen
```

Expected: `internal/db/gen/profile.sql.go` and `models.go` change.
`GetUserProfileRow` gains `OnboardedAt *time.Time` and `WhatsNewSeq int32`;
`UpdateUserProfileParams` gains `Onboarded *bool` and `WhatsNewSeq *int32`.

If the generated field names differ from those, **use whatever sqlc
produced** and carry those names into Task 2 — do not hand-edit generated
code.

- [ ] **Step 7: Verify the whole Go suite still builds and passes**

```bash
cd apps/server && go vet ./... && go test ./... ; echo "exit=$?"
```

Expected: exit 0 — everything green. Task 1 leaves nothing red behind.

A failure here almost certainly means the `CASE`/`GREATEST` expression did
not type-check against Postgres, or `UpdateUserProfileParams` changed shape
in a way `me.go`'s existing call site no longer satisfies. In the latter
case add the two new fields to that struct literal now (Task 2 Step 7 will
then find them already present) rather than leaving the package
uncompilable.

- [ ] **Step 8: Commit**

```bash
git add apps/server/internal/db/migrations/00034_user_whats_new.sql \
        apps/server/internal/db/queries/profile.sql \
        apps/server/internal/db/gen
git commit -m "$(cat <<'EOF'
feat(server): onboarded_at and whats_new_seq on users

Two columns because they answer two different questions. Existing accounts
are backfilled as onboarded so nobody is toured retroactively; whats_new_seq
needs no backfill because the SPA ships no entry older than this migration.

The seq write is GREATEST, not assignment: mutations queue offline, and a
dismissal replayed two days later must not walk the marker backwards.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: API — the two fields on `/api/me`

**Files:**
- Modify: `openapi/pjokk.yaml` (`Me` ~line 5132, `UpdateMe` ~line 5061)
- Modify: `apps/server/internal/api/me.go`
- Modify: `apps/server/internal/api/me_whats_new_test.go`
- Modify: `apps/frontend/src/lib/data/profile.ts`

**Interfaces:**
- Consumes: Task 1's `dbgen` fields.
- Produces: `Me.onboarded: boolean`, `Me.whatsNewSeq: integer` on the wire;
  `UpdateMeVars` gains `onboarded?: boolean` and `whatsNewSeq?: number`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/internal/api/me_whats_new_test.go` with the three tests
below (the defaults test moved here from Task 1 by controller ruling — it
cannot pass until this task puts the fields on the wire):

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// What's new, and a first run (issue #140): the marker is the person's and
// only ever moves forward, and a fresh account has not been onboarded.
func TestMeWhatsNewDefaults(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if me.JSON["whatsNewSeq"] != float64(0) {
		t.Errorf("default whatsNewSeq = %v, want 0", me.JSON["whatsNewSeq"])
	}
	// NewFamily creates the row through the ordinary signup path, i.e.
	// after 00034 — so it is NOT backfilled and must start un-onboarded.
	if me.JSON["onboarded"] != false {
		t.Errorf("a fresh account's onboarded = %v, want false", me.JSON["onboarded"])
	}
}
```

and, in the same file:

```go
// The marker only ever moves forward. Without GREATEST in the query, an
// offline dismissal replaying after a newer one would re-show entries.
func TestMeWhatsNewSeqNeverGoesBackwards(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": 7}); res.Status != http.StatusOK || res.JSON["whatsNewSeq"] != float64(7) {
		t.Fatalf("set 7 = %d %v", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": 3}); res.JSON["whatsNewSeq"] != float64(7) {
		t.Errorf("after replaying a stale 3, whatsNewSeq = %v, want 7", res.JSON["whatsNewSeq"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": 9}); res.JSON["whatsNewSeq"] != float64(9) {
		t.Errorf("moving forward to 9 = %v", res.JSON["whatsNewSeq"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"nickname": "Pappa"}); res.JSON["whatsNewSeq"] != float64(9) {
		t.Errorf("an unrelated PATCH changed whatsNewSeq to %v", res.JSON["whatsNewSeq"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": -1}); res.Status != http.StatusBadRequest {
		t.Errorf("whatsNewSeq=-1 = %d, want 400", res.Status)
	}
}

// onboarded is a bool on the wire over a timestamptz in the row, and the
// date survives a re-run of the tour from Settings.
func TestMeOnboardedRoundTrip(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"onboarded": true}); res.Status != http.StatusOK || res.JSON["onboarded"] != true {
		t.Fatalf("set onboarded = %d %v", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"units": "imperial"}); res.JSON["onboarded"] != true {
		t.Errorf("an unrelated PATCH changed onboarded to %v", res.JSON["onboarded"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"onboarded": false}); res.JSON["onboarded"] != false {
		t.Errorf("clearing onboarded = %v", res.JSON["onboarded"])
	}
	if me := a.Do(http.MethodGet, "/api/me", cookie, nil); me.JSON["onboarded"] != false {
		t.Errorf("onboarded after clear = %v", me.JSON["onboarded"])
	}
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/server && go test ./internal/api -run 'TestMeWhatsNew|TestMeOnboarded' -v
```

Expected: FAIL. The PATCHes are rejected by spec validation (the fields are
not in `UpdateMe`), so statuses are 400 and the JSON has no such keys.

- [ ] **Step 3: Add the fields to the spec**

In `openapi/pjokk.yaml`, in `UpdateMe`'s `properties` (after `language`):

```yaml
        onboarded:
          type: boolean
          description: >-
            True once this person has finished or skipped the getting-started
            carousel (issue #140). Stored as a timestamp; exposed as a bool
            because the date is nobody's business but support's.
        whatsNewSeq:
          type: integer
          minimum: 0
          maximum: 100000
          description: >-
            The highest what's-new entry seq this person has seen. The
            server keeps the GREATEST of stored and incoming — mutations
            queue offline, and a stale replay must not walk it backwards.
```

In `Me`, add both to the `required` list (after `languageMode`):

```yaml
          languageMode,
          onboarded,
          whatsNewSeq,
        ]
```

and to `Me`'s `properties`:

```yaml
        onboarded:
          type: boolean
          description: >-
            False only for someone who has never finished or skipped the
            getting-started carousel. Accounts predating migration 00034 are
            backfilled true.
        whatsNewSeq:
          type: integer
          minimum: 0
```

- [ ] **Step 4: Regenerate both sides**

```bash
export PATH="$PATH:$HOME/.local/go/bin:$HOME/go/bin"
cd apps/server && go generate ./... && cd ../..
bun run gen:client
git diff --stat apps/server/internal/api/gen apps/server/internal/api/pjokk.yaml packages/shared/src/api-schema.d.ts
```

Expected: all three change. `gen.Me` gains `Onboarded bool` and
`WhatsNewSeq int`; `gen.UpdateMe` gains pointers to both.

- [ ] **Step 5: Read the fields in the handler**

In `apps/server/internal/api/me.go`, inside `UpdateMe`, after the `langSet`
line and **before** `if err := p.Err()`:

```go
	onboardedSet, onboardedVal := patchField[bool](p, "onboarded")
	seqSet, seqVal := patchField[int32](p, "whatsNewSeq")
```

- [ ] **Step 6: Validate them**

In the same function, after the existing `langSet` validation block and
before the `d.Q.UpdateUserProfile` call:

```go
	// What's new, and a first run (00034). Both are the spec's types, so
	// validation already refused a literal null; guard the nil anyway, the
	// same way units and the language pair do above.
	if onboardedSet && onboardedVal == nil {
		return gen.UpdateMe400JSONResponse(gen.Error{Error: "Onboarded must be true or false", Code: "VALIDATION"}), nil
	}
	if seqSet {
		if seqVal == nil || *seqVal < 0 {
			return gen.UpdateMe400JSONResponse(gen.Error{Error: "whatsNewSeq must be zero or more", Code: "VALIDATION"}), nil
		}
	}
```

- [ ] **Step 7: Pass them to the query**

Extend the `dbgen.UpdateUserProfileParams` literal in the same function:

```go
	if err := d.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID:           session.UserID,
		Name:         &name,
		Nickname:     nickname,
		Phone:        phone,
		Units:        units,
		LanguageMode: modeVal,
		Language:     langVal,
		Onboarded:    onboardedVal,
		WhatsNewSeq:  seqVal,
	}); err != nil {
		return nil, err
	}
```

- [ ] **Step 8: Put them on the wire**

In `buildMe`, extend the `gen.Me` literal (after `LanguageMode`):

```go
		// A bool on the wire over a timestamptz in the row: the client has
		// no use for the date, and a nullable timestamp is a shape we would
		// spend the next year explaining.
		//
		// .Valid, NOT a nil check: sqlc generated OnboardedAt as
		// pgtype.Timestamptz (following AvatarImportedAt in the same file),
		// which is a struct, so `!= nil` does not compile.
		Onboarded:   profile.OnboardedAt.Valid,
		WhatsNewSeq: int(profile.WhatsNewSeq),
```

- [ ] **Step 9: Run the tests**

```bash
cd apps/server && go test ./internal/api -run 'TestMeWhatsNew|TestMeOnboarded' -v
```

Expected: PASS, all three tests.

- [ ] **Step 10: Run the whole Go suite**

```bash
cd apps/server && go vet ./... && go test ./...
```

Expected: PASS. `spec_sync_test.go` confirms the embedded copy matches.

- [ ] **Step 11: Widen the client's mutation vars**

In `apps/frontend/src/lib/data/profile.ts`, extend `UpdateMeVars`:

```ts
export interface UpdateMeVars {
  name?: string;
  nickname?: string | null;
  phone?: string | null;
  units?: "metric" | "imperial";
  languageMode?: LanguageMode;
  language?: "en" | "nb";
  onboarded?: boolean;
  whatsNewSeq?: number;
}
```

Add below `useSaveLanguage`:

```ts
// The what's-new marker and the first-run flag (issue #140). No log row
// shows either, so no log view is invalidated — the same reasoning as
// useSaveLanguage above.
export function useSaveWhatsNew() {
  return useProfileMutation(
    (vars: Pick<UpdateMeVars, "onboarded" | "whatsNewSeq">) =>
      unwrap<Me>(client.PATCH("/api/me", { body: vars })),
    false,
  );
}
```

- [ ] **Step 12: Typecheck**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add openapi/pjokk.yaml apps/server/internal/api apps/frontend/src/lib/data/profile.ts packages/shared/src/api-schema.d.ts
git commit -m "$(cat <<'EOF'
feat(api): onboarded and whatsNewSeq on /api/me

No new endpoints: both ride the existing getMe/updateMe pair. onboarded is
a bool on the wire over a timestamptz in the row.

Tests cover the GREATEST guard directly, because the failure it prevents —
a stale offline dismissal re-showing entries — is invisible in normal use.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Content and the pure selector

**Files:**
- Create: `apps/frontend/src/data/whats-new.ts`
- Create: `apps/frontend/src/lib/whats-new.ts`
- Create: `apps/frontend/test/whats-new.test.ts`
- Modify: `apps/frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `Feature` from `@pjokk/shared`; `familyTracks` from `@/lib/tracking`.
- Produces:
  - `type WhatsNewEntry = { seq: number; version: string; title: string; body: string; feature?: Feature; icon: TablerIcon; tint: string }`
  - `type GuideCard = { key: string; title: string; body: string; icon: TablerIcon; tint: string }`
  - `whatsNew: WhatsNewEntry[]` (ascending `seq`)
  - `gettingStarted: GuideCard[]`
  - `pending(entries, seq, tracks): WhatsNewEntry[]` — newest first
  - `highestSeq(entries): number`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/test/whats-new.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { Feature } from "@pjokk/shared";
import { IconSparkles } from "@tabler/icons-react";
import { highestSeq, pending, type WhatsNewEntry } from "../src/lib/whats-new";

// What's new (issue #140): which entries a person is shown, and what
// dismissal marks. The nag must never repeat, and must never announce a
// feature the family has switched off.
const entry = (
  seq: number,
  feature?: Feature,
): WhatsNewEntry => ({
  seq,
  version: `v0.${seq}.0`,
  title: `Entry ${seq}`,
  body: "Body",
  feature,
  icon: IconSparkles,
  tint: "text-accent",
});

const all = () => true;
const none = () => false;

describe("pending", () => {
  it("returns only entries newer than the marker, newest first", () => {
    const got = pending([entry(1), entry(2), entry(3)], 1, all);
    expect(got.map((e) => e.seq)).toEqual([3, 2]);
  });

  it("is exclusive at the boundary", () => {
    expect(pending([entry(5)], 5, all)).toEqual([]);
  });

  it("drops an entry whose feature the family does not track", () => {
    const got = pending([entry(1), entry(2, "daycare")], 0, (k) => k !== "daycare");
    expect(got.map((e) => e.seq)).toEqual([1]);
  });

  it("keeps an entry with no feature even when nothing is tracked", () => {
    const got = pending([entry(1)], 0, none);
    expect(got.map((e) => e.seq)).toEqual([1]);
  });

  it("is empty for an empty catalogue", () => {
    expect(pending([], 0, all)).toEqual([]);
  });
});

describe("highestSeq", () => {
  it("is 0 for an empty catalogue", () => {
    expect(highestSeq([])).toBe(0);
  });

  it("counts entries the family cannot see", () => {
    // Dismissal must mark the filtered-out entry seen too: otherwise
    // switching barnehage on six months later replays a stale
    // announcement as though it were news.
    expect(highestSeq([entry(1), entry(9, "daycare")])).toBe(9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test apps/frontend/test/whats-new.test.ts
```

Expected: FAIL — `Cannot find module '../src/lib/whats-new'`.

- [ ] **Step 3: Write the selector**

Create `apps/frontend/src/lib/whats-new.ts`:

```ts
import type { Feature } from "@pjokk/shared";
import type { TablerIcon } from "@tabler/icons-react";

// What's new, and a first run (spec
// docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md).
// The pure half: which entries a person is shown, and what dismissal marks.
// Content lives in data/whats-new.ts; nothing here knows what any entry says.

export type WhatsNewEntry = {
  /**
   * Monotonic. APPEND ONLY — never reorder, never reuse, never renumber. A
   * person's marker is "the highest seq I have seen", so changing what a
   * number means re-shows or silently hides entries for everyone sitting
   * on it.
   */
  seq: number;
  /** Display text only. Never compared — see seq. */
  version: string;
  title: string;
  body: string;
  /**
   * Relevance gate. An entry naming a feature is skipped entirely for a
   * family that tracks it on no baby: announcing the barnehage handover to
   * a family without barnehage is noise, and noise is what teaches people
   * to ignore the channel. Omitted means always shown.
   */
  feature?: Feature;
  icon: TablerIcon;
  tint: string;
};

/** A card in the first-run carousel. No seq: it is not a release. */
export type GuideCard = {
  key: string;
  title: string;
  body: string;
  icon: TablerIcon;
  tint: string;
};

/**
 * The entries this person has not seen and this family can use, newest
 * first. `tracks` is the family-wide union — pass
 * `(k) => familyTracks(babies.data, k)` (lib/tracking.ts), which answers
 * true while the babies are still loading, so nothing flashes.
 */
export function pending(
  entries: WhatsNewEntry[],
  seq: number,
  tracks: (key: Feature) => boolean,
): WhatsNewEntry[] {
  return entries
    .filter((e) => e.seq > seq && (!e.feature || tracks(e.feature)))
    .sort((a, b) => b.seq - a.seq);
}

/**
 * The marker to write on dismissal, over the UNFILTERED list: a family that
 * does not use barnehage still counts the barnehage entry as seen, or
 * switching the feature on six months later would replay a stale
 * announcement as though it were news.
 */
export function highestSeq(entries: WhatsNewEntry[]): number {
  return entries.reduce((max, e) => (e.seq > max ? e.seq : max), 0);
}
```

- [ ] **Step 4: Run the test**

```bash
bun test apps/frontend/test/whats-new.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the content**

Create `apps/frontend/src/data/whats-new.ts`:

```ts
import {
  IconBabyBottle,
  IconChartBar,
  IconMoon,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import type { GuideCard, WhatsNewEntry } from "@/lib/whats-new";

// The entries themselves. Content, not logic — the selection rules live in
// lib/whats-new.ts.
//
// HOW TO ADD ONE: append to `whatsNew` with the next seq, in the same PR as
// the feature it describes, and add its two strings to the nb dictionary in
// lib/i18n.ts (bun run check fails until you do). Never renumber, never
// reorder, never reuse a seq — see WhatsNewEntry.seq.
//
// DELIBERATELY NO BACKLOG (spec, "No backlog"): nothing is written here for
// a feature that shipped before this mechanism existed. A first run that
// listed every feature ever shipped would be the tutorial wall CLAUDE.md's
// information architecture bans.
export const whatsNew: WhatsNewEntry[] = [
  {
    seq: 1,
    version: "v0.48.0",
    title: t("A quiet note when something changes"),
    body: t(
      "New things now show up as one line here on Home. Tap to read them, or brush it away — everything stays under Settings.",
    ),
    icon: IconSparkles,
    tint: "text-accent",
  },
];

// The first run, for someone who arrived by invite and has never seen the
// app. Not generated from the entries above: a newcomer wants to know what
// the app is for, not what changed last Tuesday.
export const gettingStarted: GuideCard[] = [
  {
    key: "status",
    title: t("A glance, not a log"),
    body: t(
      "Home answers when she last ate, slept and was changed — before you tap anything.",
    ),
    icon: IconMoon,
    tint: "text-sleep",
  },
  {
    key: "log",
    title: t("Two taps to log"),
    body: t(
      "Open, save. Every form remembers the last one, and you can always fix the time afterwards.",
    ),
    icon: IconBabyBottle,
    tint: "text-feed",
  },
  {
    key: "together",
    title: t("Everyone sees the same thing"),
    body: t(
      "Whoever is with her can log it. Entries say who did the care, which is useful the morning after.",
    ),
    icon: IconUsers,
    tint: "text-accent",
  },
  {
    key: "more",
    title: t("The rest can wait"),
    body: t(
      "Timeline, Stats and Calendar are there when you want them. Nothing needs setting up first.",
    ),
    icon: IconChartBar,
    tint: "text-growth",
  },
];
```

**The tint tokens are not free-form.** The ones in use are `text-accent`,
`text-diaper`, `text-feed` (singular), `text-growth`, `text-muted` and
`text-sleep` — verify against `apps/frontend/src/lib/tracking.ts` before
inventing one; `text-feeds` and `text-measurements` do not exist.

```
```

- [ ] **Step 6: Add the Norwegian**

In `apps/frontend/src/lib/i18n.ts`, add a new section to the `nb` dictionary
(follow the existing section-comment style):

```ts
  // What's new, and a first run (issue #140)
  "A quiet note when something changes": "En rolig beskjed når noe endrer seg",
  "New things now show up as one line here on Home. Tap to read them, or brush it away — everything stays under Settings.":
    "Nye ting dukker opp som én linje her på Hjem. Trykk for å lese, eller børst den bort — alt ligger under Innstillinger.",
  "A glance, not a log": "Et blikk, ikke en loggbok",
  "Home answers when she last ate, slept and was changed — before you tap anything.":
    "Hjem svarer på når hun sist spiste, sov og ble skiftet — før du trykker på noe.",
  "Two taps to log": "To trykk for å logge",
  "Open, save. Every form remembers the last one, and you can always fix the time afterwards.":
    "Åpne, lagre. Hvert skjema husker forrige gang, og du kan alltid rette tiden etterpå.",
  "Everyone sees the same thing": "Alle ser det samme",
  "Whoever is with her can log it. Entries say who did the care, which is useful the morning after.":
    "Den som er med henne kan logge det. Oppføringene sier hvem som gjorde det, noe som er nyttig dagen etter.",
  "The rest can wait": "Resten kan vente",
  "Timeline, Stats and Calendar are there when you want them. Nothing needs setting up first.":
    "Tidslinje, Statistikk og Kalender er der når du vil ha dem. Ingenting må settes opp først.",
```

- [ ] **Step 7: Verify lint, i18n and types**

```bash
bun run check && bun test apps/frontend/test/whats-new.test.ts
```

Expected: PASS both. If `check-i18n.mjs` names a missing key, add it —
that is the gate working.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/data/whats-new.ts apps/frontend/src/lib/whats-new.ts \
        apps/frontend/test/whats-new.test.ts apps/frontend/src/lib/i18n.ts
git commit -m "$(cat <<'EOF'
feat(frontend): what's-new entries and the selector

The pure half, with the content beside it. pending() filters by seq and by
the family's enabled features; highestSeq() counts the entries the family
cannot see, so switching a feature on later does not replay a stale
announcement as news.

No backlog: the first entry announces the mechanism itself.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extract the generic `Carousel`

**Files:**
- Create: `apps/frontend/src/components/Carousel.tsx`
- Modify: `apps/frontend/src/components/tracking/TrackingCarousel.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  function Carousel(props: {
    steps: ReactNode[];
    onFinish: () => void;
    testIdPrefix: string;
    finishLabel?: string;
    ariaLabel?: string;
  }): JSX.Element
  ```
  Test ids emitted: `${testIdPrefix}-strip`, `${testIdPrefix}-next`,
  `${testIdPrefix}-done`.

**This is the riskiest change in the PR.** `TrackingCarousel` contains
already-solved scroll-timing bugs (the `target` ref and the `scrollend`
listener). It must come out behaviour-identical, and
`e2e/tracking.spec.ts` is the guard.

- [ ] **Step 1: Establish the baseline — run the tracking e2e spec BEFORE changing anything**

```bash
bash scripts/e2e-stack.sh   # check the script's own name/flags first
bunx playwright test e2e/tracking.spec.ts --config e2e/playwright.config.ts
```

Expected: PASS. If it fails before you touch anything, stop and report —
you cannot use a red test as a refactor guard.

- [ ] **Step 2: Write the generic component**

Create `apps/frontend/src/components/Carousel.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The paced-strip shell, lifted out of components/tracking/TrackingCarousel
// when the first run (issue #140) needed a second one. A scroll-snap strip
// with Back / Next as the primary control — the app's no-swipe rule is
// about ROUTE navigation fighting the back gesture; swiping here is a bonus
// nobody needs.
//
// Everything about WHAT the steps say stays with the caller. This file owns
// only the strip, the dots, the buttons and the scroll bookkeeping.
export function Carousel({
  steps,
  onFinish,
  testIdPrefix,
  finishLabel,
  ariaLabel,
}: {
  steps: ReactNode[];
  onFinish: () => void;
  testIdPrefix: string;
  finishLabel?: string;
  ariaLabel?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const last = steps.length - 1;

  // The card a button asked for, while the smooth scroll is still on its
  // way there. Without it the scroll handler below reads the strip's
  // position mid-flight and sets the index BACK, so Done turns into Next
  // for a few frames — and a tap in those frames lands on Next (seen on a
  // slow CI runner). A swipe has no target, so its position is trusted at
  // once.
  const target = useRef<number | null>(null);
  const goTo = (i: number) => {
    const el = strip.current;
    if (!el) return;
    target.current = i;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setIndex(i);
  };
  const positionIndex = () => {
    const el = strip.current;
    if (!el || el.clientWidth === 0) return null;
    return Math.round(el.scrollLeft / el.clientWidth);
  };
  const onScroll = () => {
    const i = positionIndex();
    if (i === null) return;
    if (target.current !== null) {
      if (i === target.current) target.current = null; // arrived
      return;
    }
    setIndex(i);
  };
  // A programmatic scroll a swipe interrupted never "arrives": once the
  // strip has come to rest anywhere, the position is the truth again.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const settle = () => {
      target.current = null;
      const i = positionIndex();
      if (i !== null) setIndex(i);
    };
    el.addEventListener("scrollend", settle);
    return () => el.removeEventListener("scrollend", settle);
  }, []);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col pt-safe md:max-w-lg">
      <div
        ref={strip}
        onScroll={onScroll}
        // overflow-y-hidden: a scroll container clips its box-shadows, so
        // the light-up ring must stay inside the strip and the strip must
        // never scroll vertically (which would push the ring to the edge).
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
        data-testid={`${testIdPrefix}-strip`}
        aria-label={ariaLabel}
      >
        {steps.map((step, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed strip
            key={i}
            className="flex w-full shrink-0 snap-center flex-col"
          >
            {step}
          </div>
        ))}
      </div>
      {/* pb-tabbar clears the bottom bar on the phone (styles.css). */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-tabbar">
        <Button
          variant="outline"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
        >
          {t("Back")}
        </Button>
        <div className="flex gap-1" aria-hidden>
          {Array.from({ length: steps.length }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed strip of dots
              key={i}
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                i === index ? "bg-accent" : "bg-line",
              )}
            />
          ))}
        </div>
        {index < last ? (
          <Button
            onClick={() => goTo(index + 1)}
            data-testid={`${testIdPrefix}-next`}
          >
            {t("Next")}
          </Button>
        ) : (
          <Button onClick={onFinish} data-testid={`${testIdPrefix}-done`}>
            {finishLabel ?? t("Done")}
          </Button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Expose `goTo` for the recommended-set jump**

`TrackingCarousel`'s "Use the recommended set" button jumps to the last
card, which is inside `Carousel`'s state. Add an imperative escape hatch to
`Carousel` — a ref object the caller can read:

In `Carousel.tsx`, add to the props type:

```tsx
  /**
   * Filled with a jump function on mount, for a caller that needs to move
   * the strip from inside a step (tracking's "Use the recommended set").
   * A ref rather than a controlled index: the strip's position is the
   * truth here, and a second source would fight the scroll bookkeeping.
   */
  controls?: { current: { goTo: (i: number) => void } | null };
```

and inside the component, before the `return`:

```tsx
  useEffect(() => {
    if (!controls) return;
    controls.current = { goTo };
    return () => {
      controls.current = null;
    };
  });
```

- [ ] **Step 4: Re-point `TrackingCarousel` at it**

Rewrite `apps/frontend/src/components/tracking/TrackingCarousel.tsx` so it
builds a `steps` array and renders `<Carousel>`. Replace everything from
`const navigate = useNavigate();` to the end of the component with:

```tsx
  const navigate = useNavigate();
  const track = useTracking(baby);
  const save = useSetBabyFeatures();
  const months = ageMonths(new Date(baby.birthDate));
  const controls = useRef<{ goTo: (i: number) => void } | null>(null);
  const last = featureCards.length; // the summary's index

  const set = (features: Feature[]) =>
    save.mutate({ babyId: baby.id, features });
  const flip = (key: Feature, on: boolean) =>
    set(on ? [...baby.features, key] : baby.features.filter((k) => k !== key));
  const done = () =>
    isNew
      ? navigate({ to: "/home" })
      : navigate({
          to: "/settings/baby/$babyId",
          params: { babyId: baby.id },
        });

  const steps = [
    ...featureCards.map((meta, i) => (
      <>
        {i === 0 && isNew && isAdmin && (
          <Card className="mx-4 mt-4 space-y-3 text-center">
            <p className="text-sm text-ink-soft">
              {t(
                "Swipe through what Pjokk can track, or take the set we suggest for a baby of",
              )}{" "}
              {formatAge(new Date(baby.birthDate))}.
            </p>
            <Button
              size="full"
              onClick={() => {
                set(recommended(months));
                controls.current?.goTo(last);
              }}
              data-testid="use-recommended"
            >
              {t("Use the recommended set")}
            </Button>
          </Card>
        )}
        <TrackingCard
          meta={meta}
          on={track.has(meta.key)}
          tag={
            meta.key === "daycare"
              ? `${t("Recommended if")} ${baby.name} ${t("goes to barnehage")}`
              : recommendedByAge(meta.key, months)
                ? `${t("Recommended at")} ${baby.name}${t("'s age")}`
                : null
          }
          readOnly={!isAdmin}
          onToggle={(on) => flip(meta.key, on)}
        />
      </>
    )),
    <section
      className="flex flex-1 flex-col justify-center gap-4 px-4"
      data-testid="tracking-summary"
      aria-label={t("Summary")}
    >
      <h2 className="text-2xl font-extrabold text-ink">
        {t("Tracking for")} {baby.name}
      </h2>
      {track.any ? (
        <ul className="space-y-2">
          {featureCards
            .filter((m) => track.has(m.key))
            .map((m) => {
              const Icon = m.icon;
              return (
                <li
                  key={m.key}
                  className="flex items-center gap-2 font-semibold text-ink"
                >
                  <Icon className={cn("h-5 w-5", m.tint)} />
                  {t(m.label)}
                </li>
              );
            })}
        </ul>
      ) : (
        <p className="text-ink-soft">{t("Nothing tracked yet")}</p>
      )}
      <p className="text-sm text-muted">
        {t("Change this any time under Settings.")}
      </p>
    </section>,
  ];

  return (
    <Carousel
      steps={steps}
      onFinish={() => void done()}
      testIdPrefix="tracking"
      controls={controls}
    />
  );
}
```

Fix the imports at the top: drop `useEffect`/`useState` if now unused, keep
`useRef`, add `import { Carousel } from "@/components/Carousel";`.

Each mapped step needs a stable key — wrap in a keyed fragment:
`<Fragment key={meta.key}>…</Fragment>` (import `Fragment` from `react`).

- [ ] **Step 5: Typecheck and lint**

```bash
bun run check
```

Expected: PASS. Fix any unused-import errors it names.

- [ ] **Step 6: Run the tracking e2e spec — the refactor guard**

```bash
bunx playwright test e2e/tracking.spec.ts --config e2e/playwright.config.ts
```

Expected: PASS, identically to Step 1. This spec asserts the switch sits
inside the strip with room for the light-up ring and that the strip never
scrolls vertically — exactly the properties the extraction could break.

If it fails, do **not** adjust the test. The extraction is wrong; fix it.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/Carousel.tsx \
        apps/frontend/src/components/tracking/TrackingCarousel.tsx
git commit -m "$(cat <<'EOF'
refactor(frontend): lift the paced strip into a generic Carousel

The first run needs a second carousel, so the strip, dots, buttons and the
scroll bookkeeping move out of TrackingCarousel. Behaviour-identical;
e2e/tracking.spec.ts is the guard, including its checks that the strip never
scrolls vertically and leaves room for the light-up ring.

The "Use the recommended set" jump reaches the strip through a controls ref
rather than a controlled index: the strip's position is the truth, and a
second source would fight the scroll bookkeeping.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The list at `/whats-new`

**Files:**
- Create: `apps/frontend/src/screens/WhatsNew.tsx`
- Modify: `apps/frontend/src/router.tsx`
- Modify: `apps/frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `whatsNew` (Task 3), `familyTracks`, `useBabies`.
- Produces: route `/whats-new` rendering `WhatsNewScreen`.

- [ ] **Step 1: Write the screen**

Create `apps/frontend/src/screens/WhatsNew.tsx`:

```tsx
import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { whatsNew } from "@/data/whats-new";
import { useBabies } from "@/lib/data";
import { t } from "@/lib/i18n";
import { familyTracks } from "@/lib/tracking";
import { cn } from "@/lib/utils";

// Every entry ever written, newest first (issue #140). Deliberately a list
// and not a carousel: three new things are three cards read in one glance,
// and making someone swipe is friction applied to the person we are
// protecting.
//
// Not filtered by the person's marker — dismissal controls the nag, never
// the content. It IS filtered by what the family tracks, so the page never
// advertises a feature they have switched off.
export function WhatsNewScreen() {
  const babies = useBabies();
  const entries = whatsNew
    .filter((e) => !e.feature || familyTracks(babies.data, e.feature))
    .sort((a, b) => b.seq - a.seq);

  return (
    <div className="mx-auto max-w-md px-4 pt-safe pb-tabbar md:max-w-lg">
      <div className="flex items-center gap-2 py-3">
        <Link
          to="/profile"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-ink"
          aria-label={t("Back")}
        >
          <IconArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-extrabold text-ink">{t("What's new")}</h1>
      </div>

      {entries.length === 0 ? (
        <p className="py-8 text-center text-ink-soft">
          {t("Nothing new yet.")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="whats-new-list">
          {entries.map((e) => {
            const Icon = e.icon;
            return (
              <li
                key={e.seq}
                className="rounded-xl2 border border-line bg-surface p-4"
                data-testid={`whats-new-entry-${e.seq}`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2",
                      e.tint,
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="space-y-1">
                    <h2 className="font-semibold text-ink">{t(e.title)}</h2>
                    <p className="text-sm text-ink-soft">{t(e.body)}</p>
                    <p className="text-xs text-muted">{e.version}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

In `apps/frontend/src/router.tsx`, beside `profileRoute` (~line 147):

```tsx
// What's new (issue #140). Inside the app shell like every other screen:
// it names features, so it needs a session and a family.
const whatsNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/whats-new",
  component: WhatsNewScreen,
});
```

Add the import near the other screen imports:

```tsx
import { WhatsNewScreen } from "@/screens/WhatsNew";
```

And add `whatsNewRoute` to `appRoute.addChildren([...])`, after
`profileRoute`.

- [ ] **Step 3: Add the Norwegian**

In `apps/frontend/src/lib/i18n.ts`, in the section from Task 3:

```ts
  "What's new": "Nytt",
  "Nothing new yet.": "Ingenting nytt ennå.",
```

- [ ] **Step 4: Verify**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/screens/WhatsNew.tsx apps/frontend/src/router.tsx apps/frontend/src/lib/i18n.ts
git commit -m "$(cat <<'EOF'
feat(frontend): the what's-new list at /whats-new

A list, not a carousel: three new things are read in one glance. Shows every
entry regardless of the person's marker, because dismissal controls the nag
and never the content — which is what makes the row's x safe to be one tap.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The row on Home

**Files:**
- Create: `apps/frontend/src/components/WhatsNewLine.tsx`
- Modify: `apps/frontend/src/screens/Home.tsx`
- Modify: `apps/frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `pending`, `highestSeq`, `whatsNew`, `useMe`, `useBabies`,
  `useSaveWhatsNew` (Task 2).
- Produces: `<WhatsNewLine />`.

- [ ] **Step 1: Write the component**

Create `apps/frontend/src/components/WhatsNewLine.tsx`:

```tsx
import { IconSparkles, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { whatsNew } from "@/data/whats-new";
// The barrel, not "@/lib/data/profile": lib/data/index.ts re-exports it,
// and every screen imports profile hooks from there.
import { useBabies, useMe, useSaveWhatsNew } from "@/lib/data";
import { t } from "@/lib/i18n";
import { familyTracks } from "@/lib/tracking";
import { highestSeq, pending } from "@/lib/whats-new";

// One quiet line at the foot of Home (issue #140), in the ClosedDayLine
// idiom. Rendered only in day-mode Home, which is why there is no night
// check here: Home returns early into NightHome, so this subtree does not
// exist at 03:00.
//
// The x is the point. Dismissing must never require opening anything — the
// person who opened the app to log a bottle taps once and it is gone. It
// can be that aggressive because dismissal loses nothing: /whats-new keeps
// every entry (spec §7).
export function WhatsNewLine() {
  const me = useMe();
  const babies = useBabies();
  const navigate = useNavigate();
  const save = useSaveWhatsNew();

  const seq = me.data?.whatsNewSeq;
  if (seq === undefined) return null;

  const unseen = pending(whatsNew, seq, (k) => familyTracks(babies.data, k));
  if (unseen.length === 0) return null;

  // Over the UNFILTERED list: see highestSeq's comment.
  const markSeen = () => save.mutate({ whatsNewSeq: highestSeq(whatsNew) });

  return (
    <div className="px-4 pb-3" data-testid="whats-new-line">
      <div className="flex items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
          <IconSparkles className="h-4 w-4" />
        </span>
        <button
          type="button"
          className="flex-1 text-left font-semibold text-ink"
          data-testid="whats-new-open"
          onClick={() => {
            markSeen();
            void navigate({ to: "/whats-new" });
          }}
        >
          {unseen.length === 1
            ? t("1 new thing since you were away")
            : `${unseen.length} ${t("new things since you were away")}`}
        </button>
        <button
          type="button"
          // 44 px minimum touch target: this is a one-handed, half-asleep
          // tap and missing it means opening a screen nobody asked for.
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted"
          data-testid="whats-new-dismiss"
          aria-label={t("Dismiss")}
          onClick={markSeen}
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render it on Home**

**Not beside `<InstallBanner />`.** That component is
`fixed inset-x-4 bottom-24 z-40` — it floats over the content rather than
sitting in the flow, so its position in the tree says nothing about where it
appears. This row is an ordinary inline row and needs a real slot.

The slot is the **actions column**, after `<HomeActions>`. In
`apps/frontend/src/screens/Home.tsx` that column opens at

```tsx
      <div className="pt-4 pb-tabbar md:sticky md:top-0 md:pt-6">
        {track.any && (
          <HomeActions … />
        )}
```

and closes with its `</div>` immediately before `<FeedSheet`. Add the row
just inside that closing tag:

```tsx
        )}
        {/* Below the 2x2 grid, deliberately: the status cards and the log
            buttons must not move a pixel for this (spec, the invariant).
            Day-mode Home only — NightHome is a separate subtree. */}
        <WhatsNewLine />
      </div>
```

Placing it in the left `space-y-3` column instead (beside `ClosedDayLine`)
would be wrong: that column is above the action grid in the compact
layout, so the row would push the log buttons down.

Add the import beside the `InstallBanner` import (~line 27):

```tsx
import { WhatsNewLine } from "@/components/WhatsNewLine";
```

- [ ] **Step 3: Add the Norwegian**

```ts
  "1 new thing since you were away": "1 ny ting siden sist",
  "new things since you were away": "nye ting siden sist",
  Dismiss: "Lukk",
```

(If `Dismiss` is already in the dictionary, do not add it twice —
`check-i18n.mjs` will not complain, but biome may flag the duplicate key.)

- [ ] **Step 4: Verify**

```bash
bun run check && bun run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/WhatsNewLine.tsx apps/frontend/src/screens/Home.tsx apps/frontend/src/lib/i18n.ts
git commit -m "$(cat <<'EOF'
feat(frontend): a dismissible what's-new line at the foot of Home

Nothing above it moves: the status cards and the 2x2 grid are untouched,
because this feature may not add a tap to logging a feed. It sits in
day-mode Home only, so it does not exist at 03:00 — NightHome is a separate
subtree, which is why there is no night check in the component.

The x dismisses without opening anything, on a 44 px target.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: First run — the carousel, the redirect, and the e2e fallout

**Files:**
- Create: `apps/frontend/src/screens/GettingStarted.tsx`
- Modify: `apps/frontend/src/router.tsx`
- Modify: `apps/frontend/src/screens/shell.tsx`
- Modify: `apps/frontend/src/screens/Welcome.tsx`
- Modify: `e2e/helpers.ts`
- Modify: `e2e/invite.spec.ts`
- Modify: `apps/frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `Carousel` (Task 4), `gettingStarted` (Task 3),
  `useSaveWhatsNew` (Task 2).
- Produces: route `/getting-started`; `skipGettingStarted(page)` in
  `e2e/helpers.ts`.

**This task changes where a brand-new account lands, so it breaks e2e specs
until its own steps fix them. Do not split it.**

- [ ] **Step 1: Write the screen**

Create `apps/frontend/src/screens/GettingStarted.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { Carousel } from "@/components/Carousel";
import { gettingStarted, whatsNew } from "@/data/whats-new";
import { useSaveWhatsNew } from "@/lib/data";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { highestSeq } from "@/lib/whats-new";

// The first run (issue #140), for someone who arrived by invite and has
// never seen the app. Full-screen and paced, unlike anything a RETURNING
// caretaker ever sees: the cost of a tutorial is a function of when it
// appears, and setting the app up is the one moment when it is near zero.
//
// Skip is as prominent as Done on purpose. Someone who wants to get on with
// it must be able to, in one tap.
export function GettingStartedScreen() {
  const navigate = useNavigate();
  const save = useSaveWhatsNew();

  // Finishing also marks the release notes caught up: a brand-new account
  // must never be shown what changed in versions it never missed.
  const finish = () => {
    save.mutate({ onboarded: true, whatsNewSeq: highestSeq(whatsNew) });
    void navigate({ to: "/home" });
  };

  const steps = gettingStarted.map((card) => {
    const Icon = card.icon;
    return (
      <section
        key={card.key}
        className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
        data-testid={`getting-started-card-${card.key}`}
      >
        <span
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-full bg-surface-2",
            card.tint,
          )}
        >
          <Icon className="h-8 w-8" />
        </span>
        <h2 className="text-2xl font-extrabold text-ink">{t(card.title)}</h2>
        <p className="max-w-xs text-ink-soft">{t(card.body)}</p>
      </section>
    );
  });

  return (
    <div className="relative min-h-dvh">
      <button
        type="button"
        className="absolute right-4 z-10 rounded-full px-4 py-2 font-semibold text-muted top-safe"
        data-testid="getting-started-skip"
        onClick={finish}
      >
        {t("Skip")}
      </button>
      <Carousel
        steps={steps}
        onFinish={finish}
        testIdPrefix="getting-started"
        finishLabel={t("Start using Pjokk")}
        ariaLabel={t("Getting started")}
      />
    </div>
  );
}
```

If `top-safe` is not an existing utility in `styles.css`, use
`style={{ top: "env(safe-area-inset-top, 0px)" }}` instead.

- [ ] **Step 2: Add the route**

In `apps/frontend/src/router.tsx`, beside `welcomeRoute` (~line 179):

```tsx
// The first run (issue #140). Outside the app shell, like /welcome: it is
// full-screen and has no tab bar, and AppChrome is what redirects into it.
const gettingStartedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/getting-started",
  component: GettingStartedScreen,
});
```

Import it, and add `gettingStartedRoute` to the top-level
`rootRoute.addChildren([...])` array, after `welcomeRoute`.

- [ ] **Step 3: Redirect from `AppChrome`**

In `apps/frontend/src/screens/shell.tsx`, inside `AppChrome`, immediately
after `const me = useMe();` (line 117):

```tsx
  // The first run (issue #140). Here rather than in AuthGate because it
  // needs a settled `me`, and below the kiosk check in AppShell because an
  // enrolled tablet holds no person's session and must never land here.
  //
  // Founders never see it: Welcome.tsx sets onboarded when it creates the
  // baby, so they go on to the tracking carousel instead of being pulled
  // out of it into a second one.
  const onboarded = me.data?.onboarded;
```

and immediately before the `return (`:

```tsx
  if (onboarded === false) return <Navigate to="/getting-started" />;
```

Confirm `Navigate` is already imported in this file (it is — `AuthGate`
uses it).

- [ ] **Step 4: Mark founders onboarded**

In `apps/frontend/src/screens/Welcome.tsx`, find the baby-creation handler
that navigates to the tracking route with `search: { new: true }` (~line 90).
Before that navigate, PATCH the flag:

```tsx
      // A founder has just been through Welcome and is about to go through
      // the tracking carousel; a third screen would be the wall the first
      // run exists to avoid (spec §8). The invitee, who gets neither, is
      // the one who needs orientation.
      await unwrap(client.PATCH("/api/me", { body: { onboarded: true } }));
      await queryClient.invalidateQueries({ queryKey: ["me"] });
```

`client` and `unwrap` are already imported in this file; `queryClient` is
already in scope.

- [ ] **Step 5: Run the e2e suite to SEE the breakage**

```bash
bunx playwright test e2e/invite.spec.ts --config e2e/playwright.config.ts
```

Expected: **FAIL** — invitees now land on `/getting-started`, not `/home`.
This is the new behaviour working. The next two steps absorb it.

- [ ] **Step 6: Add the e2e helper**

In `e2e/helpers.ts`, after `ALL_FEATURES` (~line 106):

```ts
/**
 * Marks the signed-in account onboarded so it is not redirected to the
 * first-run carousel (issue #140). Every fixture wants the "existing
 * caretaker" state — the carousel itself is e2e/whats-new.spec.ts's
 * business — exactly as ALL_FEATURES above stands in for the 00033
 * backfill.
 */
export async function skipGettingStarted(page: Page): Promise<void> {
  const res = await page.request.patch("/api/me", {
    data: { onboarded: true },
  });
  expect(res.ok(), `onboarded: ${res.status()} ${await res.text()}`).toBeTruthy();
}
```

- [ ] **Step 7: Call it where fixtures land on Home**

In `e2e/helpers.ts`, inside `uiCreateFamily`, after the features loop and
**before** `await page.goto(...)`:

```ts
  await skipGettingStarted(page);
```

(Welcome already sets it for a founder; this keeps the fixture correct even
if that changes, and costs one request.)

In `e2e/invite.spec.ts`, both invitee tests currently assert
`await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });` after
redeeming. An invitee is exactly who the carousel is for, so assert the new
behaviour rather than suppress it — replace each with:

```ts
  // A brand-new invitee is who the first run exists for (issue #140).
  await expect(invitee).toHaveURL(/\/getting-started/, { timeout: 10_000 });
  await invitee.getByTestId("getting-started-skip").click();
  await expect(invitee).toHaveURL(/\/home/, { timeout: 10_000 });
```

- [ ] **Step 8: Add the Norwegian**

```ts
  Skip: "Hopp over",
  "Start using Pjokk": "Kom i gang",
  "Getting started": "Kom i gang",
```

- [ ] **Step 9: Verify the full e2e suite**

```bash
bun run check
bunx playwright test --config e2e/playwright.config.ts
```

Expected: PASS. If a spec other than `invite.spec.ts` fails on a
`/getting-started` redirect, it signs up without going through
`uiCreateFamily` — add `await skipGettingStarted(page)` after its sign-in.

Known unrelated flakes: midnight-UTC timing in `sleep.spec.ts`. Check the
failing test names before assuming this change caused them.

- [ ] **Step 10: Commit**

```bash
git add apps/frontend/src/screens/GettingStarted.tsx apps/frontend/src/router.tsx \
        apps/frontend/src/screens/shell.tsx apps/frontend/src/screens/Welcome.tsx \
        apps/frontend/src/lib/i18n.ts e2e/helpers.ts e2e/invite.spec.ts
git commit -m "$(cat <<'EOF'
feat(frontend): a first run for a caretaker who arrives by invite

Full-screen and paced, with Skip as prominent as Done. This is the one
moment when a tutorial costs nearly nothing — a person setting the app up is
not the person logging a bottle at 03:00, which is why a RETURNING caretaker
never sees anything but a hairline row.

Founders are marked onboarded by Welcome so they are not pulled out of the
tracking carousel into a second one. The invitee, who gets neither, is the
one who needs orientation.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The way back in from Settings

**Files:**
- Modify: `apps/frontend/src/screens/Profile.tsx`
- Modify: `apps/frontend/src/screens/settings/index.tsx`
- Modify: `apps/frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: routes from Tasks 5 and 7.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add two rows to Profile**

Use the existing `NavRow` from `apps/frontend/src/screens/settings/lib.tsx`
— it already owns the row height, the chevron and the tap feedback. Do not
hand-roll a row.

In `apps/frontend/src/screens/Profile.tsx`, in the section-composition block
(~line 236, where `<InstallSection />` sits), add after `<InstallSection />`:

```tsx
            {/* Dismissing the line on Home must lose nothing (issue #140),
                so both ways back live here. */}
            <SectionTitle>{t("About")}</SectionTitle>
            <Card className="divide-y divide-line p-0">
              <NavRow to="/whats-new" label={t("What's new")} />
              <NavRow to="/getting-started" label={t("Getting started")} />
            </Card>
```

Import `NavRow` from `./settings/lib` (match the path style the file already
uses for its other settings-section imports). `SectionTitle` and `Card` are
already in scope in this file.

If `About` is not already a dictionary key, add it: `About: "Om"`.

- [ ] **Step 2: Make the version string a link**

In `apps/frontend/src/screens/settings/index.tsx` the footer is:

```tsx
        <p className="py-6 text-center text-xs text-muted">
          <a href="/api/docs" className="underline">
            {t("API docs")}
          </a>
          {/* The server's build version — the image tag, not a number kept
              by hand (internal/buildinfo). */}
          {me.data ? ` · Pjokk ${me.data.version}` : null}
        </p>
```

Replace only the version expression, leaving the `<p>` and the API-docs
anchor untouched:

```tsx
          {/* The server's build version — the image tag, not a number kept
              by hand (internal/buildinfo). Tappable because the version
              number is exactly what a person taps to ask what is in it
              (issue #140). */}
          {me.data ? (
            <>
              {" · "}
              <Link to="/whats-new" className="underline">
                {`Pjokk ${me.data.version}`}
              </Link>
            </>
          ) : null}
```

Import `Link` from `@tanstack/react-router` if this file does not already
import it.

- [ ] **Step 3: Verify**

```bash
bun run check && bun run test
```

Expected: PASS. (`What's new` and `Getting started` are already in the
dictionary from Tasks 5 and 7.)

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/screens/Profile.tsx apps/frontend/src/screens/settings/index.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): reach what's new from Settings

Two rows on the profile and a tappable version string in the Settings hub.
This is what makes the row's x safe: dismissing controls the nag, never the
content.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: The e2e spec, and the gate

**Files:**
- Create: `e2e/whats-new.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the spec**

Create `e2e/whats-new.spec.ts`:

```ts
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// What's new, and a first run (spec
// docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md).
// The invariant under test: a caretaker who has already onboarded is never
// interrupted, dismissal is one tap, and dismissing loses nothing.

// A fresh account is already at whats_new_seq = 0 and seq starts at 1, so
// every entry is unseen and the line shows with no setup. (An earlier draft
// had a `rewind` helper here; it asserted that precondition rather than
// establishing anything, so it was dropped by controller ruling.)

test("the line appears on Home, opens the list, and one tap dismisses it", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "whats-new");

  const line = page.getByTestId("whats-new-line");
  await expect(line).toBeVisible();

  // The log grid must not have moved: the row lives below it.
  await expect(
    page.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();

  await page.getByTestId("whats-new-dismiss").click();
  await expect(line).toBeHidden();
  // Dismissing must not navigate anywhere.
  await expect(page).toHaveURL(/\/home/);

  // And it must stay gone across a reload — the marker is on the server.
  await page.reload();
  await expect(page.getByTestId("whats-new-line")).toBeHidden();
});

test("dismissing loses nothing: the list still has every entry", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "whats-new-list");
  await page.getByTestId("whats-new-dismiss").click();
  await expect(page.getByTestId("whats-new-line")).toBeHidden();

  await page.goto("/whats-new");
  await expect(page.getByTestId("whats-new-list")).toBeVisible();
  await expect(page.getByTestId("whats-new-entry-1")).toBeVisible();
});

test("the line is absent in night mode", async ({ page, request, context }) => {
  await freshFamily(page, request, "whats-new-night");
  await expect(page.getByTestId("whats-new-line")).toBeVisible();

  // NightHome is a separate subtree: three actions and nothing else.
  await context.addInitScript(() => {
    localStorage.setItem("pjokk.night.mode", "on");
  });
  await page.reload();
  await expect(page.getByTestId("whats-new-line")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();
});
```

Note: `freshFamily` calls `skipGettingStarted`, which only sets
`onboarded` — it does not touch `whatsNewSeq`, so a fresh account still has
the line. If a test above finds the line already hidden, check that
`skipGettingStarted` has not been widened to write `whatsNewSeq`.

- [ ] **Step 2: Run the new spec**

```bash
bunx playwright test e2e/whats-new.spec.ts --config e2e/playwright.config.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3: Run every gate, and read the exit codes**

Run each and confirm it exits 0. Do not grep the output and declare
success — check `echo $?`.

```bash
export PATH="$PATH:$HOME/.local/go/bin:$HOME/go/bin"
docker compose -f docker-compose.test.yml up -d

cd apps/server && go vet ./... ; echo "go vet: $?"
cd apps/server && go test ./... ; echo "go test: $?"
cd /home/anders/projects/refsdal/pjokk && bun run check ; echo "check: $?"
bun run test ; echo "bun test: $?"
bunx playwright test --config e2e/playwright.config.ts ; echo "e2e: $?"
```

Also run every step `.github/workflows/test.yml` runs, `golangci-lint`
included — CI runs steps this plan does not list.

- [ ] **Step 4: Commit and push**

```bash
git add e2e/whats-new.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): the what's-new line, its dismissal, and night mode

Covers the invariant rather than the markup: the log grid does not move, one
tap dismisses without navigating, the dismissal survives a reload because the
marker is on the server, and the list still holds every entry afterwards.

Issue #140

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 5: Take the PR out of draft and update its body**

```bash
gh pr ready 141
```

Then update the PR body to describe what shipped, replacing the
"Draft — the design is in, the implementation is not" note. Watch CI by
parsing the plain table — the local `gh` is 2.46.0 and `gh pr checks` has no
`--json`:

```bash
gh pr checks 141
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 Data, migration `00034` | Task 1 |
| §2 API, no new endpoints, `GREATEST`, `CASE` for `onboarded` | Tasks 1–2 |
| §3 Content model, append-only `seq` | Task 3 |
| §4 Selection, `pending` / `highestSeq` | Task 3 |
| §5 The Home line, the ×, day-mode only | Task 6 |
| §6 The list at `/whats-new` | Task 5 |
| §7 Where it lives afterwards (3 ways back) | Tasks 5, 8 |
| §8 First run, redirect, founders excluded | Task 7 |
| §9 The `Carousel` extraction | Task 4 |
| Testing: Go, unit, e2e, i18n | Tasks 1, 2, 3, 9 |

No spec section is unimplemented.

**Type consistency**

`WhatsNewEntry` and `GuideCard` are defined once in `lib/whats-new.ts` and
imported by `data/whats-new.ts`, `WhatsNew.tsx`, `WhatsNewLine.tsx` and
`GettingStarted.tsx`. `pending(entries, seq, tracks)` and
`highestSeq(entries)` keep the same signatures in Tasks 3, 6 and 7.
`useSaveWhatsNew` is defined in Task 2 and used in Tasks 6 and 7.
`Carousel`'s props are fixed in Task 4 and consumed unchanged in Task 7.
Test id prefixes: `tracking-*` (preserved), `whats-new-*`,
`getting-started-*`.

**Known risk, called out rather than hidden**

Task 1 Step 6 depends on sqlc's generated field names for a `narg`'d `CASE`
expression, which is the one place this plan cannot predict the output
exactly. The step says to use whatever sqlc produces and carry those names
forward, rather than guessing. If sqlc cannot infer the parameter types, add
explicit casts (`sqlc.narg('onboarded')::bool` is already cast for this
reason).
