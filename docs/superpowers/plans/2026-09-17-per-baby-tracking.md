# Per-baby tracking switches — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One set of feature switches per baby that removes a feature's entry points from every screen when off, chosen from a carousel of cards after creating a baby, with a set recommended from the birth date.

**Architecture:** A `features text[]` column on `baby` (enabled keys, backfilled to all thirteen for existing babies), one admin-only `PUT /api/babies/{id}/features`, and two job checks (reminders hold, closing alerts skip). Everything else is the client: one hook over `Baby.features` gates Home, More, Timeline chips, Stats, Settings, Reminders and the Kiosk, and a full-screen carousel page with live mocks and a light-up toggle edits the set.

**Tech Stack:** Go 1.27 + sqlc + goose + oapi-codegen (server); Vite + React + TanStack Router/Query + Tailwind (SPA); bun test (unit), Playwright (e2e), Go tests against a real Postgres.

**Spec:** `docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md`

## Global Constraints

- The thirteen keys, in this order everywhere: `feeds, pump, sleep, diapers, medicine, measurements, milestones, bath, notes, play, daycare, illness, vaccines`.
- The spec (`openapi/pjokk.yaml`) is edited by hand; run `go generate ./...` from `apps/server` and `bun run gen:client` from the root after; never hand-edit `apps/server/internal/api/pjokk.yaml` or `packages/shared/src/api-schema.d.ts`.
- Writes are never refused for an off kind. Hiding is the client's job.
- `SetBabyFeatures` is `tierAdmin` and NOT in `deviceOperations`.
- Every user-facing string goes through `t()` and gets a Norwegian entry in `apps/frontend/src/lib/i18n.ts` (`bun run check` fails otherwise).
- Category tints only on icons and the light-up ring; night mode collapses to amber via the existing tokens; `prefers-reduced-motion` reduces the light-up to a crossfade.
- Toolchain quirks (from memory): Go and sqlc are at `~/.local/go/bin` and `~/go/bin`; the test Postgres runs on port 56432 (`TEST_DATABASE_URL`), never 55432; run the Go suite with `-p 1`; never run the Go suite while an e2e stack build is in progress; the full Playwright run needs `--workers=2`.
- Commit style: Conventional Commits, small scoped commits, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Spec, migration, queries and generated code

**Files:**
- Modify: `openapi/pjokk.yaml` (the `Baby` schema near line 4948, the baby routes after `/api/babies/{id}/usual-nap` near line 224, new schemas beside `SetUsualNap` near line 6581)
- Create: `apps/server/internal/db/migrations/00033_baby_features.sql`
- Modify: `apps/server/internal/db/queries/core.sql`
- Create: `apps/server/internal/api/features.go`
- Modify: `apps/server/internal/api/babies.go` (`serBaby`)
- Modify: `apps/server/internal/testrig/http.go` (`NewBaby`)
- Test: `apps/server/internal/api/features_test.go`
- Generated (committed): `apps/server/internal/api/gen/*.go`, `apps/server/internal/api/pjokk.yaml`, `apps/server/internal/db/gen/*.go`, `packages/shared/src/api-schema.d.ts`

**Interfaces:**
- Produces: `gen.Feature` (string enum) and `gen.Baby.Features []gen.Feature`; `gen.SetBabyFeaturesRequestObject{Id, Body *gen.SetBabyFeatures{Features []gen.Feature}}`; `dbgen.SetBabyFeaturesParams{FamilyID, ID string; Features []string}` returning `dbgen.Baby`; `dbgen.BabyTracksParams{FamilyID string; BabyID *string; Feature string}` returning `bool`; `api.AllFeatures []string`.

- [ ] **Step 1: Write the failing test** — `apps/server/internal/api/features_test.go`

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): a
// `features` array on every Baby, all thirteen for a baby that predates
// the column (testrig.NewBaby mirrors the backfill), none for a baby
// created over the API — she chooses second, on the carousel.

func TestBabyFeaturesDefaultEmptyOverTheAPI(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	res := a.Do(http.MethodPost, "/api/babies", cookie, map[string]any{
		"name": "Emil", "birthDate": "2026-06-15T00:00:00Z",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("POST /api/babies = %d %s", res.Status, res.Raw)
	}
	features, ok := res.JSON["features"].([]any)
	if !ok || len(features) != 0 {
		t.Fatalf("features = %v, want []", res.JSON["features"])
	}
}

func TestSeededBabyTracksEverything(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	a.NewBaby(familyID, "Nora")
	list := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	baby := list.JSON[0].(map[string]any)
	features, _ := baby["features"].([]any)
	if len(features) != len(api.AllFeatures) {
		t.Fatalf("features = %v, want all %d", features, len(api.AllFeatures))
	}
	for i, f := range api.AllFeatures {
		if features[i] != f {
			t.Errorf("features[%d] = %v, want %q", i, features[i], f)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH && TEST_DATABASE_URL=postgres://pjokk:pjokk@127.0.0.1:56432/pjokk_test?sslmode=disable go test ./internal/api -run 'TestBabyFeatures|TestSeededBaby' 2>&1 | tail -5`
Expected: FAIL — `api.AllFeatures` undefined (compile error). Check `docker compose -f docker-compose.test.yml ps` first and read `TEST_DATABASE_URL` from `apps/server/internal/testrig` if the URL above is wrong.

- [ ] **Step 3: Edit the spec** — in `openapi/pjokk.yaml`

Add to the `Baby` schema: `features` in `required` and this property:

```yaml
        features:
          type: array
          description: >-
            What the family tracks for this baby (spec
            2026-09-17-per-baby-tracking-design.md): the ENABLED keys. A
            switch that is off hides a feature's entry points in the app and
            holds its reminders; the server still accepts every write. All
            thirteen for a baby that predates the column, none for a new
            baby until the carousel runs.
          items:
            $ref: "#/components/schemas/Feature"
```

Add the schemas next to `SetUsualNap`:

```yaml
    Feature:
      type: string
      description: One per-baby tracking switch, in the app's display order.
      enum:
        - feeds
        - pump
        - sleep
        - diapers
        - medicine
        - measurements
        - milestones
        - bath
        - notes
        - play
        - daycare
        - illness
        - vaccines
    SetBabyFeatures:
      type: object
      required: [features]
      properties:
        features:
          type: array
          items:
            $ref: "#/components/schemas/Feature"
```

Add the route after `/api/babies/{id}/usual-nap`:

```yaml
  /api/babies/{id}/features:
    put:
      operationId: setBabyFeatures
      summary: >-
        Replace what the family tracks for this baby. Family-admin only;
        never a kiosk device. Whole-set replacement so a replayed offline
        save is harmless. Duplicates are dropped; order is the enum's.
      tags: [babies]
      parameters:
        - $ref: "#/components/parameters/idPath"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/SetBabyFeatures"
      responses:
        "200":
          description: The baby, as it now reads.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Baby"
        "403":
          description: Family admin only.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
        "404":
          description: No baby with this id in the caller's family.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
```

- [ ] **Step 4: Write the migration** — `apps/server/internal/db/migrations/00033_baby_features.sql`

```sql
-- +goose Up

-- What the family tracks for this baby (spec
-- docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): the
-- ENABLED keys of the thirteen per-baby switches. A column rather than a
-- table because a switch set is a set: it rides with the baby, needs no
-- restore or backup rule of its own, and is replaced whole. A switch that
-- is off hides a feature's entry points in the app and holds its
-- reminders (internal/jobs); the server still accepts every write.
ALTER TABLE "baby" ADD COLUMN "features" text[] NOT NULL DEFAULT '{}';

-- Every baby that exists today keeps everything: nobody's app changes on
-- upgrade. A baby created from now on starts empty and chooses on the
-- carousel. The list is api.AllFeatures, in the spec's order.
UPDATE "baby" SET "features" = ARRAY[
  'feeds', 'pump', 'sleep', 'diapers', 'medicine', 'measurements',
  'milestones', 'bath', 'notes', 'play', 'daycare', 'illness', 'vaccines'
];

-- +goose Down
ALTER TABLE "baby" DROP COLUMN "features";
```

- [ ] **Step 5: Add the queries** — append to `apps/server/internal/db/queries/core.sql` after `DeleteBaby`

```sql
-- name: SetBabyFeatures :one
-- The per-baby tracking switches (00033), replaced whole. RETURNING * so
-- the route answers with the Baby, as UpdateBaby does.
UPDATE "baby"
SET "features" = $3
WHERE "family_id" = $1 AND "id" = $2
RETURNING *;

-- name: BabyTracks :one
-- Does this baby — or, with no baby, ANY baby of the family — track this
-- feature? What the reminder and closing-alert jobs ask before firing
-- (internal/jobs): a reminder with no baby applies to each baby that has
-- the kind on, so it is held only when none does.
SELECT EXISTS (
    SELECT 1 FROM "baby"
    WHERE "family_id" = sqlc.arg(family_id)
      AND (sqlc.narg(baby_id)::text IS NULL OR "id" = sqlc.narg(baby_id))
      AND sqlc.arg(feature)::text = ANY("features")
)::bool AS tracked;
```

- [ ] **Step 6: Generate**

Run: `cd apps/server && export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH && sqlc generate && go generate ./... && cd ../.. && bun run gen:client`
Expected: no output from sqlc; `internal/api/gen/types.gen.go` now has `type Feature string`, `SetBabyFeatures`, and `Baby.Features []Feature`; `internal/db/gen/models.go` has `Features []string` on `Baby`; `packages/shared/src/api-schema.d.ts` has `Feature`. Check with `grep -n "Features" internal/db/gen/models.go internal/api/gen/types.gen.go | head`. The Go build now fails until Step 7 (`serBaby` and the new strict-interface method) — expected.

- [ ] **Step 7: The feature list and `serBaby`** — create `apps/server/internal/api/features.go`

```go
package api

import "github.com/refsdal/pjokk/server/internal/api/gen"

// AllFeatures is every per-baby tracking switch, in the spec's order
// (openapi/pjokk.yaml `Feature`; spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md). The
// backfill in 00033_baby_features.sql and testrig.NewBaby both mean this
// list; TestAllFeaturesMatchTheSpec keeps it honest.
var AllFeatures = []string{
	"feeds", "pump", "sleep", "diapers", "medicine", "measurements",
	"milestones", "bath", "notes", "play", "daycare", "illness", "vaccines",
}

// featuresOf is the wire shape of a baby's column: never null, so a baby
// with nothing tracked reads as [] and the SPA's includes() has an array.
func featuresOf(stored []string) []gen.Feature {
	out := make([]gen.Feature, 0, len(stored))
	for _, f := range stored {
		out = append(out, gen.Feature(f))
	}
	return out
}

// normaliseFeatures drops duplicates and puts the set in the spec's order,
// so two saves of the same set store the same array whatever the client
// sent. Unknown keys cannot reach here: the request validator refuses them.
func normaliseFeatures(in []gen.Feature) []string {
	want := make(map[string]bool, len(in))
	for _, f := range in {
		want[string(f)] = true
	}
	out := make([]string, 0, len(want))
	for _, f := range AllFeatures {
		if want[f] {
			out = append(out, f)
		}
	}
	return out
}
```

In `apps/server/internal/api/babies.go`, add the field to `serBaby`:

```go
func serBaby(b dbgen.Baby) gen.Baby {
	return gen.Baby{
		Id:        b.ID,
		Name:      b.Name,
		BirthDate: b.BirthDate.Time,
		Sex:       babySexPtr(b.Sex),
		AvatarUrl: babyAvatarURL(b.ID, b.AvatarKey),
		Features:  featuresOf(b.Features),
	}
}
```

Add a temporary stub so the package compiles before Task 2 (Task 2 replaces it):

```go
// SetBabyFeatures implements PUT /api/babies/{id}/features — see Task 2.
func (d Deps) SetBabyFeatures(ctx context.Context, req gen.SetBabyFeaturesRequestObject) (gen.SetBabyFeaturesResponseObject, error) {
	return nil, errNoRequestBody("SetBabyFeatures")
}
```

Add `"SetBabyFeatures": tierAdmin,` to `operationAuthTiers` in `apps/server/internal/api/api.go`, right under `"DeleteBaby": tierAdmin,`. Do NOT add it to `deviceOperations`. If `api.go` has a test that every operation in the generated interface has a tier (`api_internal_test.go`), this is what satisfies it.

- [ ] **Step 8: Seed everything in `testrig.NewBaby`** — `apps/server/internal/testrig/http.go`

Change `NewBaby` so a seeded baby mirrors the backfill (every existing test assumes every feature is on). `testrig` may not import `internal/api` if `api` imports `testrig`'s dependencies in a cycle; check with `go list -deps ./internal/testrig | grep internal/api`. If there is no cycle, use `api.AllFeatures`; otherwise copy the list into a `var allFeatures` in testrig with a comment pointing at `api.AllFeatures`, and add a testrig test asserting the two are equal.

```go
func (a *AppRig) NewBaby(familyID, name string) string {
	a.t.Helper()
	baby, err := a.Deps.Q.CreateBaby(context.Background(), gen.CreateBabyParams{
		FamilyID:  familyID,
		Name:      name,
		BirthDate: pgtype.Timestamptz{Time: time.Date(2025, 10, 20, 0, 0, 0, 0, time.UTC), Valid: true},
	})
	if err != nil {
		a.t.Fatalf("testrig: NewBaby(%q, %q): %v", familyID, name, err)
	}
	// A seeded baby is an "existing" baby: everything tracked, as the
	// 00033 backfill leaves the babies a deployment already has.
	if _, err := a.Deps.Q.SetBabyFeatures(context.Background(), gen.SetBabyFeaturesParams{
		FamilyID: familyID, ID: baby.ID, Features: api.AllFeatures,
	}); err != nil {
		a.t.Fatalf("testrig: NewBaby(%q, %q) features: %v", familyID, name, err)
	}
	return baby.ID
}
```

- [ ] **Step 9: The spec-vs-list test** — append to `features_test.go`

```go
func TestAllFeaturesMatchTheSpec(t *testing.T) {
	doc, err := openapi3.NewLoader().LoadFromData(api.SpecYAML)
	if err != nil {
		t.Fatal(err)
	}
	enum := doc.Components.Schemas["Feature"].Value.Enum
	if len(enum) != len(api.AllFeatures) {
		t.Fatalf("spec enum %v, AllFeatures %v", enum, api.AllFeatures)
	}
	for i, v := range enum {
		if v != api.AllFeatures[i] {
			t.Errorf("enum[%d] = %v, AllFeatures[%d] = %q", i, v, i, api.AllFeatures[i])
		}
	}
}
```

`api.SpecYAML` is whatever the package already exports for the embedded `pjokk.yaml` (find it with `grep -n "go:embed" apps/server/internal/api/*.go`); if the embed var is unexported, export a `SpecYAML` alias in the same file rather than embedding twice. Import `github.com/getkin/kin-openapi/openapi3` (already a dependency).

- [ ] **Step 10: Run the tests and the whole package**

Run: `cd apps/server && export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH && go build ./... && go vet ./... && TEST_DATABASE_URL=... go test -p 1 ./internal/api -run 'Features|SeededBaby' 2>&1 | tail -5`
Expected: PASS for all three.

- [ ] **Step 11: Commit**

```bash
git add openapi/pjokk.yaml apps/server packages/shared/src/api-schema.d.ts
git commit -m "feat(api): a features column on baby, the thirteen per-baby tracking switches

The spec's Feature enum, Baby.features, the 00033 migration (backfilled
to everything for babies that exist), the SetBabyFeatures and BabyTracks
queries, and testrig seeding every switch on. The route itself follows.

Spec: docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `PUT /api/babies/{id}/features`

**Files:**
- Modify: `apps/server/internal/api/features.go` (replace the stub from Task 1)
- Test: `apps/server/internal/api/features_test.go`

**Interfaces:**
- Consumes: `dbgen.SetBabyFeaturesParams`, `normaliseFeatures`, `serBaby`, `notFound()`, `errNoRequestBody`.
- Produces: the route; `403 {"error":"Admin only","code":"FORBIDDEN"}` for a member (from `middleware.RequireAdmin`), `403 NOT_FOR_DEVICES` for a kiosk, `400 VALIDATION` for an unknown key (from the request validator), `404 NOT_FOUND` for another family's baby.

- [ ] **Step 1: Write the failing tests** — append to `features_test.go`

```go
func TestSetBabyFeaturesReplacesTheSetInSpecOrder(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", cookie, map[string]any{
		"features": []string{"diapers", "sleep", "sleep", "feeds"},
	})
	if res.Status != http.StatusOK {
		t.Fatalf("PUT = %d %s", res.Status, res.Raw)
	}
	got, _ := res.JSON["features"].([]any)
	if len(got) != 3 || got[0] != "feeds" || got[1] != "sleep" || got[2] != "diapers" {
		t.Fatalf("features = %v, want [feeds sleep diapers] (deduped, spec order)", got)
	}

	list := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	if f, _ := list.JSON[0].(map[string]any)["features"].([]any); len(f) != 3 {
		t.Errorf("GET /api/babies features = %v, want the three", f)
	}

	empty := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", cookie, map[string]any{"features": []string{}})
	if f, _ := empty.JSON["features"].([]any); empty.Status != http.StatusOK || len(f) != 0 {
		t.Errorf("PUT [] = %d %v, want 200 []", empty.Status, empty.JSON["features"])
	}
}

func TestSetBabyFeaturesIsAdminOnlyAndValidated(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	memberID := a.SignUp("Plain member", "member@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "member@example.com")

	forbidden := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", memberCookie, map[string]any{"features": []string{"sleep"}})
	if forbidden.Status != http.StatusForbidden || forbidden.JSON["code"] != "FORBIDDEN" {
		t.Errorf("member PUT = %d %v, want 403 FORBIDDEN", forbidden.Status, forbidden.JSON)
	}

	bad := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", adminCookie, map[string]any{"features": []string{"sleep", "unicorns"}})
	if bad.Status != http.StatusBadRequest || bad.JSON["code"] != "VALIDATION" {
		t.Errorf("unknown key PUT = %d %v, want 400 VALIDATION", bad.Status, bad.JSON)
	}

	otherFamily, otherCookie := a.NewFamily("Olsen", "other@example.com")
	_ = otherFamily
	missing := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", otherCookie, map[string]any{"features": []string{"sleep"}})
	if missing.Status != http.StatusNotFound {
		t.Errorf("other family's PUT = %d %s, want 404", missing.Status, missing.Raw)
	}
}
```

Also add `{http.MethodPut, "/api/babies/" + w.babyID + "/features", map[string]any{"features": []string{"sleep"}}}` to the table in `TestDeviceIsRefusedOutsideTheAllowlist` in `devices_access_test.go` (the kiosk 403).

- [ ] **Step 2: Run to verify they fail**

Run: `go test -p 1 ./internal/api -run 'TestSetBabyFeatures|TestDeviceIsRefused' 2>&1 | tail -8`
Expected: FAIL — the stub returns 500 on every call.

- [ ] **Step 3: Implement** — replace the stub in `features.go`

```go
// SetBabyFeatures implements PUT /api/babies/{id}/features: the family's
// choice of what to track for one child, replaced whole. tierAdmin (a
// member sees the set and cannot change it) and never a kiosk device
// (deviceOperations is unchanged). The server stores the set and gates
// NOTHING on it — a write for an off kind is still accepted, from an API
// key or a queued offline save alike — because a switch is a preference
// about the UI, not a permission; the two jobs that read it (reminders,
// closing alerts) hold rather than refuse.
func (d Deps) SetBabyFeatures(ctx context.Context, req gen.SetBabyFeaturesRequestObject) (gen.SetBabyFeaturesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetBabyFeatures")
	}
	baby, err := d.Q.SetBabyFeatures(ctx, dbgen.SetBabyFeaturesParams{
		FamilyID: fam.FamilyID,
		ID:       req.Id,
		Features: normaliseFeatures(req.Body.Features),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.SetBabyFeatures404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	return gen.SetBabyFeatures200JSONResponse(serBaby(baby)), nil
}
```

(Imports: `context`, `errors`, `github.com/jackc/pgx/v5`, `gen`, `middleware`, `dbgen`.)

- [ ] **Step 4: Run the tests**

Run: `go test -p 1 ./internal/api -run 'Features|SeededBaby|TestDeviceIsRefused' 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(api): PUT /api/babies/{id}/features, admin only, never a device

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Reminders hold and closing alerts skip for an off kind

**Files:**
- Modify: `apps/server/internal/jobs/reminders.go`
- Modify: `apps/server/internal/jobs/daycare_closing.go`
- Test: `apps/server/internal/jobs/reminders_test.go`, `apps/server/internal/jobs/daycare_closing_test.go`

**Interfaces:**
- Consumes: `d.Q.BabyTracks(ctx, dbgen.BabyTracksParams{FamilyID, BabyID *string, Feature string}) (bool, error)`.
- Produces: `featureForKind(kind string) string` in `reminders.go` (`feed→feeds, diaper→diapers, pump→pump, medicine→medicine, else ""`).

- [ ] **Step 1: Write the failing tests**

Append to `reminders_test.go`:

```go
// A reminder for a kind the baby does not track is held, like quiet hours:
// switching Feeds off must not mean a 3 a.m. nudge about a bottle nobody
// logs any more, and switching it back on must not need a new reminder.
func TestRunRemindersHoldForAnUntrackedKind(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "features")
	addReminder(t, a, cookie, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC", "babyId": babyID})

	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": now.Add(-6 * time.Hour).Format(time.RFC3339), "type": "bottle", "amountMl": 100})

	setFeatures := func(features ...string) {
		res := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", cookie, map[string]any{"features": features})
		if res.Status != http.StatusOK {
			t.Fatalf("set features: %d %s", res.Status, res.Raw)
		}
	}
	setFeatures("sleep", "diapers")
	if sent := run(t, a, now); sent != 0 {
		t.Fatalf("sent = %d, want 0 (feeds are not tracked)", sent)
	}
	setFeatures("sleep", "diapers", "feeds")
	if sent := run(t, a, now.Add(15*time.Minute)); sent != 1 {
		t.Fatalf("sent = %d, want 1 (held, not latched)", sent)
	}
}

// A family-wide reminder (no baby) is held only when NO baby tracks the kind.
func TestRunRemindersFamilyWideHoldsOnlyWhenNoBabyTracks(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	nora := a.NewBaby(familyID, "Nora")
	emil := a.NewBaby(familyID, "Emil")
	subscribe(t, a, cookie, "family-wide")
	addReminder(t, a, cookie, map[string]any{"kind": "diaper", "mode": "since_last", "intervalMin": 120, "tz": "UTC"})
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	logAt(t, a, cookie, "/api/diapers", map[string]any{"babyId": nora, "time": now.Add(-5 * time.Hour).Format(time.RFC3339), "type": "wet"})

	for _, id := range []string{nora, emil} {
		if res := a.Do(http.MethodPut, "/api/babies/"+id+"/features", cookie, map[string]any{"features": []string{"sleep"}}); res.Status != http.StatusOK {
			t.Fatalf("set features: %d %s", res.Status, res.Raw)
		}
	}
	if sent := run(t, a, now); sent != 0 {
		t.Fatalf("sent = %d, want 0 (no baby tracks diapers)", sent)
	}
	if res := a.Do(http.MethodPut, "/api/babies/"+emil+"/features", cookie, map[string]any{"features": []string{"sleep", "diapers"}}); res.Status != http.StatusOK {
		t.Fatalf("set features: %d %s", res.Status, res.Raw)
	}
	if sent := run(t, a, now.Add(15*time.Minute)); sent != 1 {
		t.Fatalf("sent = %d, want 1 (Emil tracks diapers)", sent)
	}
}
```

Append to `daycare_closing_test.go`:

```go
// Barnehage switched off for the baby: enrolled or not, no alert.
func TestClosingAlertSkipsABabyNotTrackingDaycare(t *testing.T) {
	w := newClosingWorld(t)
	if res := w.a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/features", w.cookie, map[string]any{"features": []string{"sleep"}}); res.Status != http.StatusOK {
		t.Fatalf("set features: %d %s", res.Status, res.Raw)
	}
	dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
	if sent := runClosing(t, w.a, osloMarch16(16, 15)); sent != 0 {
		t.Errorf("sent = %d, want 0 (daycare is not tracked for her)", sent)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test -p 1 ./internal/jobs -run 'Untracked|FamilyWideHolds|SkipsABabyNotTracking' 2>&1 | tail -8`
Expected: FAIL — `sent = 1, want 0` in each.

- [ ] **Step 3: Implement the hold** — `reminders.go`

Add after the quiet-hours `continue` in `RunReminders`, before `switch r.Mode`:

```go
		// A kind the baby does not track is held, not latched (spec
		// 2026-09-17-per-baby-tracking-design.md): the switch is a
		// preference about the app, and the reminder fires again the tick
		// after it comes back. A custom reminder has no kind to be off.
		if f := featureForKind(r.Kind); f != "" {
			tracked, err := d.Q.BabyTracks(ctx, dbgen.BabyTracksParams{FamilyID: r.FamilyID, BabyID: r.BabyID, Feature: f})
			if err != nil {
				return sent, fmt.Errorf("jobs: tracked kind for reminder %s: %w", r.ID, err)
			}
			if !tracked {
				continue
			}
		}
```

And the helper, next to `holdsAtDaycare`:

```go
// featureForKind maps a reminder kind onto the per-baby switch that hides
// it (lib/tracking.ts reminderKindFeature is the SPA's copy of this map).
func featureForKind(kind string) string {
	switch kind {
	case "feed":
		return "feeds"
	case "diaper":
		return "diapers"
	case "pump":
		return "pump"
	case "medicine":
		return "medicine"
	}
	return ""
}
```

- [ ] **Step 4: Implement the skip** — `daycare_closing.go`, first thing inside the `for _, r := range rows` loop

```go
		tracked, err := d.Q.BabyTracks(ctx, dbgen.BabyTracksParams{FamilyID: r.FamilyID, BabyID: &r.BabyID, Feature: "daycare"})
		if err != nil {
			return sent, fmt.Errorf("jobs: tracked daycare for %s: %w", r.ID, err)
		}
		if !tracked {
			continue // barnehage switched off for her: no alert, no latch
		}
```

Note `r.BabyID` is a `string` on the candidates row; `BabyTracksParams.BabyID` is `*string` (from `sqlc.narg`). If the generated row field is already a pointer, pass it directly.

- [ ] **Step 5: Run the job suites**

Run: `go test -p 1 ./internal/jobs 2>&1 | tail -5`
Expected: PASS (the new three and everything existing — the seeded babies track everything).

- [ ] **Step 6: Commit**

```bash
git add apps/server/internal/jobs
git commit -m "feat(jobs): reminders hold and closing alerts skip for a kind the baby does not track

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The shared type, the catalogue and the recommendation

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `apps/frontend/src/lib/tracking.ts`
- Modify: `apps/frontend/src/lib/data/family.ts` (the mutation)
- Test: `apps/frontend/test/tracking.test.ts`

**Interfaces:**
- Produces (from `@pjokk/shared`): `type Feature`, `const features` (the runtime list).
- Produces (from `@/lib/tracking`):
  - `type FeatureGroup = "everyday" | "health" | "daycare" | "extras"`
  - `type FeatureMeta = { key: Feature; label: string; description: string; group: FeatureGroup; tint: string; icon: TablerIcon }`
  - `const featureCatalogue: FeatureMeta[]` (thirteen, spec order)
  - `const groupTitles: Record<FeatureGroup, string>`
  - `type CoreKey = "feeds" | "diapers" | "sleep"`; `const coreKeys: CoreKey[]` in Home order `["feeds", "diapers", "sleep"]`
  - `ageMonths(birthDate: Date, now?: Date): number` (whole calendar months, floor)
  - `recommended(ageMonths: number): Feature[]`
  - `recommendedByAge(key: Feature, ageMonths: number): boolean`
  - `tracks(baby: Baby | undefined, key: Feature): boolean`
  - `familyTracks(babies: Baby[] | undefined, key: Feature): boolean` (true while the list is unknown)
  - `type Tracking = { has: (key: Feature) => boolean; any: boolean; anyMore: boolean }`
  - `tracking(baby: Baby | undefined): Tracking` (pure) and `useTracking(baby: Baby | undefined): Tracking` (memoised)
  - `otherKindFeature(kind: OtherKind): Feature`, `reminderKindFeature(kind: ReminderKind): Feature | null`, `logParamFeature(log: string): Feature | null`
  - `enabledLabels(baby: Baby): string[]` (English labels in catalogue order, for a settings row's sub line)
- Produces (from `@/lib/data`): `useSetBabyFeatures(babyId: string)` — a `useMutation` keyed `["setBabyFeatures"]` with defaults registered by `registerFamilyMutationDefaults(qc)`, variables `{ babyId: string; features: Feature[] }`, optimistic on `["babies"]`.

- [ ] **Step 1: Write the failing test** — `apps/frontend/test/tracking.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { features } from "@pjokk/shared";
import type { Baby } from "@pjokk/shared";
import {
  ageMonths,
  enabledLabels,
  familyTracks,
  featureCatalogue,
  logParamFeature,
  otherKindFeature,
  recommended,
  reminderKindFeature,
  tracking,
} from "../src/lib/tracking";

const baby = (f: Baby["features"]): Baby => ({
  id: "b1",
  name: "Ida",
  birthDate: "2026-06-15T00:00:00.000Z",
  sex: null,
  avatarUrl: null,
  features: f,
});

describe("featureCatalogue", () => {
  it("lists every spec key once, in the spec's order", () => {
    expect(featureCatalogue.map((f) => f.key)).toEqual([...features]);
  });
  it("carries a label, a description, a group, a tint and an icon for each", () => {
    for (const f of featureCatalogue) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(["everyday", "health", "daycare", "extras"]).toContain(f.group);
      expect(f.tint.startsWith("text-")).toBe(true);
      expect(typeof f.icon).toBe("object");
    }
  });
});

describe("ageMonths", () => {
  const born = new Date(2026, 5, 15); // 15 June 2026, local
  it("counts whole calendar months", () => {
    expect(ageMonths(born, new Date(2026, 6, 14))).toBe(0);
    expect(ageMonths(born, new Date(2026, 6, 15))).toBe(1);
    expect(ageMonths(born, new Date(2026, 9, 14))).toBe(3);
    expect(ageMonths(born, new Date(2026, 9, 15))).toBe(4);
    expect(ageMonths(born, new Date(2027, 5, 15))).toBe(12);
  });
});

describe("recommended", () => {
  it("under four months: the newborn set", () => {
    expect(recommended(0)).toEqual(["feeds", "sleep", "diapers", "measurements"]);
    expect(recommended(3)).toEqual(["feeds", "sleep", "diapers", "measurements"]);
  });
  it("four to twelve months adds milestones and play", () => {
    expect(recommended(4)).toEqual(["feeds", "sleep", "diapers", "measurements", "milestones", "play"]);
    expect(recommended(11)).toEqual(["feeds", "sleep", "diapers", "measurements", "milestones", "play"]);
  });
  it("twelve months and up drops feeds, keeps diapers, adds medicine and illness — never daycare", () => {
    expect(recommended(12)).toEqual(["sleep", "diapers", "medicine", "illness"]);
    expect(recommended(30)).toEqual(["sleep", "diapers", "medicine", "illness"]);
  });
  it("never recommends pump, daycare, vaccines, bath or notes at any age", () => {
    for (const m of [0, 4, 12, 36]) {
      for (const k of ["pump", "daycare", "vaccines", "bath", "notes"]) {
        expect(recommended(m)).not.toContain(k);
      }
    }
  });
});

describe("tracking", () => {
  it("answers has(), any and anyMore from the baby's set", () => {
    const t = tracking(baby(["feeds", "sleep"]));
    expect(t.has("feeds")).toBe(true);
    expect(t.has("bath")).toBe(false);
    expect(t.any).toBe(true);
    expect(t.anyMore).toBe(false);
    expect(tracking(baby(["feeds", "medicine"])).anyMore).toBe(true);
  });
  it("is all-off for no baby or an empty set", () => {
    expect(tracking(undefined).any).toBe(false);
    expect(tracking(baby([])).any).toBe(false);
  });
  it("familyTracks is any baby, and true while the list is unknown", () => {
    expect(familyTracks([baby(["sleep"]), baby(["daycare"])], "daycare")).toBe(true);
    expect(familyTracks([baby(["sleep"])], "daycare")).toBe(false);
    expect(familyTracks(undefined, "daycare")).toBe(true);
    expect(familyTracks([], "daycare")).toBe(false);
  });
});

describe("kind maps", () => {
  it("maps More kinds, reminder kinds and ?log= values onto switches", () => {
    expect(otherKindFeature("note")).toBe("notes");
    expect(otherKindFeature("measurement")).toBe("measurements");
    expect(otherKindFeature("milestone")).toBe("milestones");
    expect(otherKindFeature("pump")).toBe("pump");
    expect(reminderKindFeature("feed")).toBe("feeds");
    expect(reminderKindFeature("custom")).toBeNull();
    expect(logParamFeature("feed")).toBe("feeds");
    expect(logParamFeature("diaper")).toBe("diapers");
    expect(logParamFeature("sleep")).toBe("sleep");
    expect(logParamFeature("medicine")).toBe("medicine");
    expect(logParamFeature("nonsense")).toBeNull();
  });
  it("enabledLabels reads in catalogue order", () => {
    expect(enabledLabels(baby(["diapers", "feeds"]))).toEqual(["Feeds", "Diapers"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test test/tracking.test.ts 2>&1 | tail -5`
Expected: FAIL — cannot resolve `../src/lib/tracking`.

- [ ] **Step 3: The shared type** — `packages/shared/src/index.ts`

After `export type Baby = Schemas["Baby"];` add `export type Feature = Schemas["Feature"];`. After `measurementTypes` add:

```ts
// The per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md), in the
// order the carousel and every list show them.
export const features = everyOf<Feature>()([
  "feeds",
  "pump",
  "sleep",
  "diapers",
  "medicine",
  "measurements",
  "milestones",
  "bath",
  "notes",
  "play",
  "daycare",
  "illness",
  "vaccines",
]);
```

- [ ] **Step 4: The catalogue** — create `apps/frontend/src/lib/tracking.ts`

```ts
import {
  IconBabyBottle,
  IconBath,
  IconDiaper,
  IconMilk,
  IconMoon,
  IconNote,
  IconPill,
  IconRuler,
  IconSparkles,
  type TablerIcon,
  IconVaccine,
} from "@tabler/icons-react";
import { useMemo } from "react";
import type { Baby, Feature } from "@pjokk/shared";
import { features } from "@pjokk/shared";
import { daycareMeta } from "@/lib/daycare-ui";
import { illnessMeta } from "@/lib/illness-ui";
import { playKindMeta } from "@/lib/play-ui";
import type { OtherKind } from "@/components/sheets/OtherLogSheet";
import type { ReminderKind } from "@/lib/reminder-ui";

// What the family tracks for one baby (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md). The
// set lives on Baby.features, chosen on the carousel
// (components/tracking/); this file is the catalogue behind the cards, the
// age-band recommendation, and the ONE way a screen asks "is this on?" —
// nothing reads the array directly.

export type FeatureGroup = "everyday" | "health" | "daycare" | "extras";

export type FeatureMeta = {
  key: Feature;
  // English; rendered through t().
  label: string;
  description: string;
  group: FeatureGroup;
  tint: string;
  icon: TablerIcon;
};

export const groupTitles: Record<FeatureGroup, string> = {
  everyday: "Everyday",
  health: "Health",
  daycare: "Barnehage",
  extras: "Extras",
};

export const featureCatalogue: FeatureMeta[] = [
  { key: "feeds", label: "Feeds", description: "Bottles, nursing with a timer, and solids. The last feed at a glance, intake per day, and a nudge when it has been a while.", group: "everyday", tint: "text-feed", icon: IconBabyBottle },
  { key: "pump", label: "Pumping", description: "A pump timer every caretaker can see, and the amounts over the day.", group: "everyday", tint: "text-feed", icon: IconMilk },
  { key: "sleep", label: "Sleep", description: "One tap when she falls asleep, one when she wakes. How long she has been up, naps today, and last night's longest stretch.", group: "everyday", tint: "text-sleep", icon: IconMoon },
  { key: "diapers", label: "Diapers", description: "Wet, dirty or both in two taps, and the count for today.", group: "everyday", tint: "text-diaper", icon: IconDiaper },
  { key: "medicine", label: "Medicine", description: "Doses from the family's own list, and when the next one is OK from.", group: "health", tint: "text-growth", icon: IconPill },
  { key: "measurements", label: "Growth and temperature", description: "Weight, length and head against the WHO curves, and a temperature with a fever flag.", group: "health", tint: "text-growth", icon: IconRuler },
  { key: "milestones", label: "Milestones", description: "First smile, first steps — with up to three photos each.", group: "extras", tint: "text-accent", icon: IconSparkles },
  { key: "bath", label: "Baths", description: "When she last had one.", group: "extras", tint: "text-diaper", icon: IconBath },
  { key: "notes", label: "Notes", description: "A line about anything, on the timeline where it happened.", group: "extras", tint: "text-muted", icon: IconNote },
  { key: "play", label: "Play", description: "Tummy time, walks and play, timed from Home.", group: "extras", tint: playKindMeta.tummy.tint, icon: playKindMeta.tummy.icon },
  { key: "daycare", label: "Barnehage", description: "Drop-off to pick-up, what the staff said, the pick-up plan and a heads-up before closing time.", group: "daycare", tint: daycareMeta.tint, icon: daycareMeta.icon },
  { key: "illness", label: "Illness", description: "An episode from first symptom to recovered, and the days at home with a sick child.", group: "health", tint: illnessMeta.tint, icon: illnessMeta.icon },
  { key: "vaccines", label: "Vaccines", description: "The Norwegian programme as a checklist, with a place for the documents.", group: "health", tint: "text-growth", icon: IconVaccine },
];

// The carousel's order is group order, then the catalogue's within a group.
const groupOrder: FeatureGroup[] = ["everyday", "health", "daycare", "extras"];
export const featureCards: FeatureMeta[] = groupOrder.flatMap((g) =>
  featureCatalogue.filter((f) => f.group === g),
);

const metaOf = Object.fromEntries(featureCatalogue.map((f) => [f.key, f])) as Record<Feature, FeatureMeta>;
export function featureMeta(key: Feature): FeatureMeta {
  return metaOf[key];
}

export type CoreKey = "feeds" | "diapers" | "sleep";
export const coreKeys: CoreKey[] = ["feeds", "diapers", "sleep"];

// Whole calendar months, the way a health nurse counts: a baby born on the
// 15th turns one month on the 15th.
export function ageMonths(birthDate: Date, now = new Date()): number {
  let months =
    (now.getFullYear() - birthDate.getFullYear()) * 12 +
    (now.getMonth() - birthDate.getMonth());
  if (now.getDate() < birthDate.getDate()) months -= 1;
  return Math.max(0, months);
}

// The age bands (spec §The recommended set). A Norwegian barnehage child
// is one and stays in diapers until two or three, so diapers stay; feeds
// are what stops being logged. Pump, barnehage, vaccines, baths and notes
// are never recommended by age: a family knows if it needs those.
export function recommended(months: number): Feature[] {
  if (months < 4) return ["feeds", "sleep", "diapers", "measurements"];
  if (months < 12)
    return ["feeds", "sleep", "diapers", "measurements", "milestones", "play"];
  return ["sleep", "diapers", "medicine", "illness"];
}

export function recommendedByAge(key: Feature, months: number): boolean {
  return recommended(months).includes(key);
}

export function tracks(baby: Baby | undefined, key: Feature): boolean {
  return (baby?.features ?? []).includes(key);
}

// ANY baby in the family: the Family page's shared lists (medicines, the
// barnehage, …) stay while one child still uses them. True while the list
// is unknown, so nothing flashes away and back while it loads.
export function familyTracks(babies: Baby[] | undefined, key: Feature): boolean {
  if (!babies) return true;
  return babies.some((b) => tracks(b, key));
}

export type Tracking = {
  has: (key: Feature) => boolean;
  any: boolean;
  anyMore: boolean;
};

export function tracking(baby: Baby | undefined): Tracking {
  const set = new Set<Feature>(baby?.features ?? []);
  return {
    has: (key) => set.has(key),
    any: set.size > 0,
    anyMore: features.some((k) => set.has(k) && !(coreKeys as string[]).includes(k)),
  };
}

export function useTracking(baby: Baby | undefined): Tracking {
  // The array is replaced on every babies refetch; key on its contents.
  const joined = (baby?.features ?? []).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `joined` stands for baby.features
  return useMemo(() => tracking(baby), [baby?.id, joined]);
}

export function otherKindFeature(kind: OtherKind): Feature {
  switch (kind) {
    case "note":
      return "notes";
    case "measurement":
      return "measurements";
    case "milestone":
      return "milestones";
    default:
      return kind;
  }
}

// The SPA's copy of internal/jobs/reminders.go featureForKind.
export function reminderKindFeature(kind: ReminderKind): Feature | null {
  switch (kind) {
    case "feed":
      return "feeds";
    case "diaper":
      return "diapers";
    case "pump":
      return "pump";
    case "medicine":
      return "medicine";
    default:
      return null;
  }
}

// ?log= from a manifest shortcut or a push action (screens/Home.tsx).
export function logParamFeature(log: string): Feature | null {
  if (log === "feed") return "feeds";
  if (log === "diaper") return "diapers";
  if (log === "sleep") return "sleep";
  if (["medicine", "bath", "note", "milestone", "measurement", "pump"].includes(log))
    return otherKindFeature(log as OtherKind);
  return null;
}

export function enabledLabels(baby: Baby): string[] {
  return featureCatalogue.filter((f) => tracks(baby, f.key)).map((f) => f.label);
}
```

Check the exact names exported by `lib/daycare-ui.ts` (`daycareMeta`), `lib/illness-ui.ts` (`illnessMeta`) and `lib/play-ui.tsx` (`playKindMeta`) with grep and adjust; `OtherKind` and `ReminderKind` come from where `OtherLogSheet.tsx` and `reminder-ui.ts` export them (grep `export type OtherKind` / `export type ReminderKind`; if `ReminderKind` lives in `@pjokk/shared`, import it from there). If importing `OtherLogSheet.tsx` from `lib/tracking.ts` creates an import cycle once `OtherLogSheet` imports `tracking` (Task 6), move the type import to `import type` (types never cycle at runtime) — it already is.

- [ ] **Step 5: The mutation** — `apps/frontend/src/lib/data/family.ts`

Add, following the play defaults pattern:

```ts
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
        old?.map((b) => (b.id === vars.babyId ? { ...b, features: vars.features } : b)),
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
```

Import `Feature` from `@pjokk/shared`, `toast` from `@/lib/toast`, `QueryClient` type. Register it in `apps/frontend/src/lib/data/index.ts` beside the other `register*MutationDefaults` calls (find the function that calls them, usually `registerMutationDefaults(qc)`, and add `registerFamilyMutationDefaults(qc)`).

- [ ] **Step 6: Run the unit test and the typecheck**

Run: `cd apps/frontend && bun test test/tracking.test.ts 2>&1 | tail -5 && cd ../.. && bun run typecheck 2>&1 | tail -5`
Expected: PASS; typecheck clean (`Baby` now requires `features`, so any test fixture building a `Baby` literal elsewhere fails typecheck — add `features: []` or the full list to each; grep `avatarUrl: null` under `apps/frontend/test` and `e2e` to find them).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/index.ts apps/frontend/src/lib/tracking.ts apps/frontend/src/lib/data apps/frontend/test
git commit -m "feat(frontend): the tracking catalogue, the age-band recommendation and the features mutation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Home — the grid reflows, the cards follow their keys

**Files:**
- Modify: `apps/frontend/src/components/HomeActions.tsx`
- Modify: `apps/frontend/src/screens/Home.tsx`
- Create: `apps/frontend/src/components/NothingTrackedCard.tsx`
- Test: `apps/frontend/test/home-actions.test.tsx`

**Interfaces:**
- Consumes: `useTracking`, `coreKeys`, `logParamFeature`, `useMe` (for `memberRole`).
- Produces: `HomeActions` props gain `show: Record<CoreKey, boolean>`; exported `primaryGridClass(count: number): string`; `NothingTrackedCard({ baby, isAdmin })`.

- [ ] **Step 1: Write the failing tests** — add to `home-actions.test.tsx`

```ts
import { primaryGridClass } from "../src/components/HomeActions";

describe("HomeActions reflow", () => {
  it("renders only the enabled primaries, More always", () => {
    const html = renderToStaticMarkup(
      <HomeActions
        active={false}
        show={{ feeds: true, diapers: false, sleep: true }}
        onFeed={noop}
        onDiaper={noop}
        onSleep={noop}
        onMore={noop}
        actions={actions}
      />,
    );
    expect(html).toContain(">Feed<");
    expect(html).not.toContain(">Diaper<");
    expect(html).toContain(">Sleep<");
    expect(html).toContain(">More<");
  });

  it("picks the grid for the count of primaries plus More", () => {
    expect(primaryGridClass(3)).toBe("grid-cols-2 md:grid-cols-3");
    expect(primaryGridClass(2)).toBe("grid-cols-3 md:grid-cols-2");
    expect(primaryGridClass(1)).toBe("grid-cols-2 md:grid-cols-1");
  });
});
```

Update the existing renders in that file to pass `show={{ feeds: true, diapers: true, sleep: true }}`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test test/home-actions.test.tsx 2>&1 | tail -5`
Expected: FAIL — `primaryGridClass` is not exported / `show` unknown.

- [ ] **Step 3: HomeActions** — `components/HomeActions.tsx`

```tsx
import type { CoreKey } from "@/lib/tracking";

// Tailwind needs literal class names: one per count. The phone keeps More
// in the grid (3 + More = the 2×2; 2 + More = a row of three; 1 + More = a
// row of two); md hides More, so the columns are the primaries alone.
export function primaryGridClass(count: number): string {
  if (count >= 3) return "grid-cols-2 md:grid-cols-3";
  if (count === 2) return "grid-cols-3 md:grid-cols-2";
  return "grid-cols-2 md:grid-cols-1";
}

export function HomeActions({
  active,
  show,
  onFeed,
  onDiaper,
  onSleep,
  onMore,
  actions,
}: {
  active: boolean;
  show: Record<CoreKey, boolean>;
  onFeed: () => void;
  onDiaper: () => void;
  onSleep: () => void;
  onMore: () => void;
  actions: MoreAction[];
}) {
  const count = Number(show.feeds) + Number(show.diapers) + Number(show.sleep);
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("grid gap-3", primaryGridClass(count))}>
        {show.feeds && (
          <LogButton icon={IconBabyBottle} label={t("Feed")} tintClass="text-feed" onClick={onFeed} />
        )}
        {show.diapers && (
          <LogButton icon={IconDiaper} label={t("Diaper")} tintClass="text-diaper" onClick={onDiaper} />
        )}
        {show.sleep && (
          <LogButton
            icon={IconMoon}
            label={active ? t("Sleeping…") : t("Sleep")}
            tintClass="text-sleep"
            onClick={onSleep}
            disabled={active}
          />
        )}
        <LogButton icon={IconPlus} label={t("More")} tintClass="text-growth" onClick={onMore} className="md:hidden" />
      </div>
      {/* the unfolded tiles block is unchanged */}
```

Update the top-of-file comment to say the primaries are the ENABLED ones (lib/tracking.ts) and the grid reflows.

- [ ] **Step 4: The nothing-tracked card** — create `components/NothingTrackedCard.tsx`

```tsx
import { Link } from "@tanstack/react-router";
import type { Baby } from "@pjokk/shared";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";

// Home for a baby with an empty set: a brand-new baby whose carousel was
// abandoned, or a family that switched everything off. An admin gets the
// door; a member gets the fact.
export function NothingTrackedCard({ baby, isAdmin }: { baby: Baby; isAdmin: boolean }) {
  return (
    <Card className="space-y-3 text-center" data-testid="nothing-tracked">
      <p className="text-base font-bold text-ink">
        {isAdmin
          ? `${t("Choose what to track for")} ${baby.name}`
          : `${t("Nothing is tracked for")} ${baby.name} ${t("yet")}`}
      </p>
      {isAdmin && (
        <Link
          to="/settings/baby/$babyId/tracking"
          params={{ babyId: baby.id }}
          className="inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 font-bold text-white"
        >
          {t("What to track")}
        </Link>
      )}
    </Card>
  );
}
```

(The route exists from Task 9; TanStack's typed `to` will fail typecheck until then — that is fine inside this task as long as Task 9 lands before the final typecheck; if you want a green typecheck per commit, add the route in this task with a placeholder component and let Task 9 fill it.)

- [ ] **Step 5: Home** — `screens/Home.tsx`

1. After `const { babies, baby } = useSelectedBaby();` add:
   ```ts
   const track = useTracking(baby);
   const me = useMe();
   const isAdmin = me.data?.memberRole === "admin" || me.data?.memberRole === "owner";
   ```
   (`useMe` from `@/lib/data`; if Home already reads `me`, reuse it.)
2. Hotkeys: build the map conditionally —
   ```ts
   useHotkeys(
     {
       ...(track.has("feeds") ? { f: () => setSheet("feed") } : {}),
       ...(track.has("diapers") ? { d: () => setSheet("diaper") } : {}),
       ...(track.has("sleep")
         ? { s: () => (activeSleepId ? wakeSleep.mutate({ id: activeSleepId }) : setSheet("sleep")) }
         : {}),
     },
     sheet === null && !!baby,
   );
   ```
3. `?log=`: at the top of the effect body, after `if (!log || !baby) return;`, add
   ```ts
   const feature = logParamFeature(log);
   if (feature && track.has(feature)) {
     // existing branches, unchanged
   }
   void navigate({ to: "/home", search: {}, replace: true });
   ```
   and add `track` to the dependency list (or `baby.features`).
4. Night home: pass `show={{ feeds: track.has("feeds"), diapers: track.has("diapers"), sleep: track.has("sleep") }}` and inside `NightHome` wrap the Sleep/Wake row in `show.sleep &&`, the Feed row in `show.feeds &&`, the Diaper row in `show.diapers &&`. When none of the three is on, render `<p className="text-center text-sm text-muted">{t("Nothing is tracked for")} …</p>` in their place (a `NothingTrackedCard` is too bright for night).
5. Day home, in the `space-y-3` column: wrap `<ClosedDayLine />`, the daycare banner and `HandoverCard` in `track.has("daycare") &&`; `ActiveSleepBanner` in `track.has("sleep") &&`; `IllnessCard` in `track.has("illness") &&`; `ActivePlayBanner` in `track.has("play") &&`; `ActiveFeedBanner` in `track.has("feeds") &&`; `ActivePumpBanner` in `track.has("pump") &&`. The `HelpCard` stays.
6. Status cards: the last-feed card in `track.has("feeds") &&`, last-diaper in `track.has("diapers") &&`, the Awake card in `track.has("sleep") && !active && …`, the temperature card in `track.has("measurements") && …`.
7. When `!track.any`: render `<NothingTrackedCard baby={baby} isAdmin={isAdmin} />` in place of the status-card grid, and skip `<HomeActions>` entirely (the More sheet is not reachable then; the account sheet in the header still is).
8. `<HomeActions show={{ feeds: track.has("feeds"), diapers: track.has("diapers"), sleep: track.has("sleep") }} … />` and pass `actions` filtered by Task 6's `moreActions(h, track.has)` once that lands (for now pass as today).

- [ ] **Step 6: Run the unit tests and typecheck**

Run: `cd apps/frontend && bun test 2>&1 | tail -5 && cd ../.. && bun run typecheck 2>&1 | tail -3`
Expected: PASS; typecheck clean except the not-yet-existing tracking route if Step 4's note applies.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend
git commit -m "feat(home): the grid reflows to the enabled primaries, every card follows its switch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The More list, the Timeline chips, Stats

**Files:**
- Modify: `apps/frontend/src/components/sheets/OtherLogSheet.tsx` (`moreActions`)
- Modify: `apps/frontend/src/screens/Home.tsx` (both `moreActions` call sites)
- Modify: `apps/frontend/src/screens/Timeline.tsx`
- Modify: `apps/frontend/src/screens/Stats.tsx`
- Test: `apps/frontend/test/more-actions.test.ts`

**Interfaces:**
- Produces: `moreActions(h: MoreHandlers, has: (key: Feature) => boolean = () => true): MoreAction[]`.

- [ ] **Step 1: Write the failing test** — append to `more-actions.test.ts`

```ts
  it("keeps only the tiles whose switch is on, and help always", () => {
    const on = new Set(["medicine", "play", "vaccines"]);
    const keys = moreActions(
      {
        onPick: () => {},
        onPickPlay: () => {},
        onPickDaycare: () => {},
        onPickIllness: () => {},
        onPickHelp: () => {},
        onVaccines: () => {},
      },
      (k) => on.has(k),
    ).map((a) => a.key);
    expect(keys).toEqual(["medicine", "play:tummy", "play:walk", "play:play", "vaccines", "help"]);
  });
  it("with nothing on, only help remains", () => {
    const keys = moreActions(
      {
        onPick: () => {},
        onPickPlay: () => {},
        onPickDaycare: () => {},
        onPickIllness: () => {},
        onPickHelp: () => {},
        onVaccines: () => {},
      },
      () => false,
    ).map((a) => a.key);
    expect(keys).toEqual(["help"]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test test/more-actions.test.ts 2>&1 | tail -5`
Expected: FAIL — the second argument is ignored, all thirteen come back.

- [ ] **Step 3: Filter `moreActions`** — `OtherLogSheet.tsx`

```ts
import type { Feature } from "@pjokk/shared";
import { otherKindFeature } from "@/lib/tracking";

export function moreActions(
  h: MoreHandlers,
  has: (key: Feature) => boolean = () => true,
): MoreAction[] {
  const all: (MoreAction & { feature: Feature | null })[] = [
    ...(Object.keys(otherKindMeta) as OtherKind[]).map((kind) => ({
      key: kind, feature: otherKindFeature(kind), ...otherKindMeta[kind], pick: () => h.onPick(kind),
    })),
    ...playTypeOrder.map((type) => ({
      key: `play:${type}`, feature: "play" as const, ...playKindMeta[type], pick: () => h.onPickPlay(type),
    })),
    { key: "daycare", feature: "daycare", ...daycareMeta, pick: h.onPickDaycare },
    { key: "illness", feature: "illness", ...illnessMeta, pick: h.onPickIllness },
    { key: "vaccines", feature: "vaccines", label: "Vaccines", icon: IconVaccine, tint: "text-growth", pick: h.onVaccines },
    // Not a log at all — a ping to another caretaker. Never switched off.
    { key: "help", feature: null, label: "Ask for help", icon: IconHandStop, tint: "text-danger", pick: h.onPickHelp },
  ];
  return all
    .filter((a) => a.feature === null || has(a.feature))
    .map(({ feature: _feature, ...a }) => a);
}
```

Keep the existing comments. In `Home.tsx` pass `track.has` as the second argument at the `moreActions(...)` call, and give `MoreSheet` the same filter: `MoreSheet` builds its own list inside (check its body) — add a `has` prop to `MoreSheet` and pass it through, defaulting to `() => true`.

- [ ] **Step 4: Timeline chips** — `screens/Timeline.tsx`

```ts
const track = useTracking(baby);
const chipOptions = [
  { value: "all", label: t("All") },
  ...(track.has("feeds") ? [{ value: "feeds", label: t("Feeds") }] : []),
  ...(track.has("sleep") ? [{ value: "sleep", label: t("Sleep") }] : []),
  ...(track.has("diapers") ? [{ value: "diapers", label: t("Diapers") }] : []),
  ...(track.anyMore ? [{ value: "other", label: t("Other") }] : []),
];
// A filter left over from before a switch went off: back to All, so the
// history of that kind is still visible there.
useEffect(() => {
  if (filter && !chipOptions.some((o) => o.value === filter)) setFilter(null);
}, [filter, chipOptions.map((o) => o.value).join(",")]);
```

Render `options={chipOptions}`. (`baby` is already in scope from `useSelectedBaby` in that screen; check the name.)

- [ ] **Step 5: Stats** — `screens/Stats.tsx`

Add `const track = useTracking(baby);` and:
- If `!track.has("sleep") && !track.has("feeds")`: after the header, render `<p className="py-16 text-center text-sm text-muted" data-testid="stats-off">{t("Turn on Sleep or Feeds to see stats")}</p>` and return (no chips, no cards).
- The sleep `StatCard`: `track.has("sleep") &&`. The intake `StatCard`: `track.has("feeds") &&`, and its `sub` becomes `` `${s.avgFeeds} ${t("feeds")}${track.has("diapers") ? ` · ${s.avgDiapers} ${t("diapers")}` : ""}` ``.
- The Longest stretch card and the Sleep per day chart card: `track.has("sleep") &&`.
- `{ill && …}` → `{track.has("illness") && ill && …}`; `{split && …}` → `{track.has("daycare") && split && …}`; the ill/daycare marks under the chart: `anyDaycare` → `track.has("daycare") && chartData.some(…)`, `anyIll` likewise.
- The weight row + growth sheet: `track.has("measurements") &&`.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/frontend && bun test 2>&1 | tail -5 && cd ../.. && bun run check 2>&1 | tail -5`
Expected: PASS; `check` may report the new strings' missing Norwegian — add them in Task 9's i18n step or now (`"Turn on Sleep or Feeds to see stats": "Slå på Søvn eller Måltider for å se statistikk"`, `"Choose what to track for": "Velg hva som skal følges for"`, `"Nothing is tracked for": "Ingenting følges for"`, `yet: "ennå"`, `"What to track": "Hva som følges"`).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): More tiles, timeline chips and Stats follow the baby's switches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Settings, reminders and the kiosk

**Files:**
- Modify: `apps/frontend/src/lib/settings-nav.ts`, `apps/frontend/src/screens/settings/FamilyPage.tsx`
- Modify: `apps/frontend/src/screens/settings/BabyPage.tsx`
- Modify: `apps/frontend/src/components/sheets/ReminderSheet.tsx`
- Modify: `apps/frontend/src/screens/Kiosk.tsx`
- Test: `apps/frontend/test/settings-nav.test.ts`

**Interfaces:**
- Produces: `familySections(isAdmin: boolean, tracks: (key: Feature) => boolean = () => true)`; `FamilySectionMeta.feature?: Feature`.

- [ ] **Step 1: Write the failing test** — append to `settings-nav.test.ts`

```ts
  it("hides a shared list no baby uses any more", () => {
    const on = new Set(["sleep", "illness"]);
    const keys = familySections(true, (k) => on.has(k)).map((s) => s.key);
    expect(keys).toEqual(["contacts", "sleep-locations", "care-days", "api-keys", "calendar-feed", "data"]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test test/settings-nav.test.ts 2>&1 | tail -5`
Expected: FAIL — `daycare` and `medicines` still listed.

- [ ] **Step 3: settings-nav** — add `feature?: Feature` to `FamilySectionMeta`; `daycare: feature: "daycare"`, `medicines: feature: "medicine"`, `"sleep-locations": feature: "sleep"`, `"care-days": feature: "illness"`;

```ts
export function familySections(
  isAdmin: boolean,
  tracks: (key: Feature) => boolean = () => true,
): FamilySectionMeta[] {
  return sections.filter((s) => (isAdmin || !s.adminOnly) && (!s.feature || tracks(s.feature)));
}
```

Leave `familySection(key, isAdmin)` as is: a direct URL still opens (spec: hiding an entry point is not blocking a link). Update the file's comment: a row follows the family's union of switches. In `FamilyPage.tsx`: `const babies = useBabies(); const sections = familySections(isAdmin, (k) => familyTracks(babies.data, k));`.

- [ ] **Step 4: BabyPage** — after the details `Card` and `BabySheet`, before "Usual nap":

```tsx
<SectionTitle>{t("What to track")}</SectionTitle>
<Card className="p-0">
  <NavRow
    to="/settings/baby/$babyId/tracking"
    params={{ babyId: baby.id }}
    label={t("What to track")}
    sub={
      track.any
        ? enabledLabels(baby).map((l) => t(l)).join(" · ")
        : t("Nothing tracked yet")
    }
  />
</Card>
```

with `const track = useTracking(baby)` (after the `if (!baby)` guard — hooks must run unconditionally, so call `useTracking(baby)` BEFORE the guard where `baby` may be undefined). Gate: `{track.has("sleep") && (<><SectionTitle>{t("Usual nap")}</SectionTitle><UsualNapCard baby={baby} /></>)}`, and both daycare cards behind `track.has("daycare")`. Import `NavRow` from `./lib`.

- [ ] **Step 5: ReminderSheet** — the kind chips

```ts
const tracked = (k: ReminderKind) => {
  const f = reminderKindFeature(k);
  if (!f) return true;
  const chosen = babyId ? babies.find((b) => b.id === babyId) : undefined;
  return chosen ? tracks(chosen, f) : familyTracks(babies, f);
};
const kinds = (["feed", "diaper", "pump", "medicine", "custom"] as ReminderKind[]).filter(tracked);
```

Render `options={kinds.map(…)}`; add an effect: `if (!kinds.includes(kind)) changeKind(kinds[0])` keyed on `kinds.join(",")`. The baby picker is below the kinds today; the filter must react to a chosen baby, which the effect does.

- [ ] **Step 6: Kiosk** — `screens/Kiosk.tsx`

`const track = useTracking(baby);` then wrap the sleep card in `track.has("sleep") &&`, the feed card in `track.has("feeds") &&`, the diaper card in `track.has("diapers") &&`, and the medicine strip block in `track.has("medicine") && !night && medicines.length > 0`. When none of the three is on, render in the grid's place: `<p className="pt-8 text-center text-lg text-muted" data-testid="kiosk-nothing">{t("Nothing is tracked for")} {baby.name} {t("yet")}</p>`. The kiosk's nap line (`kiosk-nap`) follows `track.has("sleep")`.

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `cd apps/frontend && bun test 2>&1 | tail -5 && cd ../.. && bun run check 2>&1 | tail -5`
Expected: PASS / clean (add `"Nothing tracked yet": "Ingenting følges ennå"` to i18n).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): settings rows, reminder kinds and the kiosk follow the switches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The carousel — page, cards, mocks, light-up

**Files:**
- Modify: `apps/frontend/src/router.tsx` (the `/settings/baby/$babyId/tracking` route)
- Create: `apps/frontend/src/screens/settings/TrackingPage.tsx`
- Create: `apps/frontend/src/components/tracking/TrackingCarousel.tsx`
- Create: `apps/frontend/src/components/tracking/TrackingCard.tsx`
- Create: `apps/frontend/src/components/tracking/mocks.tsx`
- Modify: `apps/frontend/src/styles.css`
- Modify: `apps/frontend/src/screens/Welcome.tsx`, `apps/frontend/src/components/sheets/BabySheet.tsx`
- Modify: `apps/frontend/src/lib/i18n.ts`
- Test: `apps/frontend/test/tracking-card.test.tsx`

**Interfaces:**
- Consumes: `featureCards`, `recommended`, `recommendedByAge`, `ageMonths`, `useTracking`, `useSetBabyFeatures`.
- Produces: `TrackingCard({ meta, on, tag, readOnly, onToggle })`, `TrackingCarousel({ baby, isAdmin, isNew })`, `FeatureMock({ feature, on })`, route `settingsBabyTrackingRoute` with `validateSearch → { new?: boolean }`.

- [ ] **Step 1: Write the failing test** — `apps/frontend/test/tracking-card.test.tsx`

```tsx
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackingCard } from "../src/components/tracking/TrackingCard";
import { featureMeta } from "../src/lib/tracking";

const noop = () => {};

describe("TrackingCard", () => {
  it("is a switch, dimmed when off and lit when on", () => {
    const off = renderToStaticMarkup(
      <TrackingCard meta={featureMeta("diapers")} on={false} tag={null} readOnly={false} onToggle={noop} />,
    );
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('data-on="false"');
    const on = renderToStaticMarkup(
      <TrackingCard meta={featureMeta("diapers")} on tag="Recommended for Ida's age" readOnly={false} onToggle={noop} />,
    );
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('data-on="true"');
    expect(on).toContain("Recommended for Ida");
  });

  it("shows On / Off text instead of a switch for a member", () => {
    const html = renderToStaticMarkup(
      <TrackingCard meta={featureMeta("sleep")} on tag={null} readOnly onToggle={noop} />,
    );
    expect(html).not.toContain('role="switch"');
    expect(html).toContain(">On<");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/frontend && bun test test/tracking-card.test.tsx 2>&1 | tail -5`
Expected: FAIL — module not found.

- [ ] **Step 3: The mocks** — `components/tracking/mocks.tsx`

One small component per key, built from the app's own pieces. Each root carries `className="tracking-mock"` and `data-on={on}`; the part that animates once on light-up carries `className="tracking-anim"`. Keep every mock under ~15 lines. Sketch:

```tsx
import type { Feature } from "@pjokk/shared";
import { StatusCard } from "@/components/StatusCard";
import { Card } from "@/components/ui/card";
import { featureMeta } from "@/lib/tracking";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The card's illustration is the feature itself (spec §The mocks): the
// Feeds card shows the status card a family will see on Home, the Sleep
// card the sleeping banner, and so on. Real components where one fits, a
// Card in the same idiom where none does; one CSS animation each
// (styles.css .tracking-anim), played once when the switch lights up.

function Row({ feature, on, headline, detail, children }: { feature: Feature; on: boolean; headline: string; detail: string; children?: React.ReactNode }) {
  const meta = featureMeta(feature);
  return (
    <Card className="tracking-mock flex items-center gap-3" data-on={on}>
      <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2", meta.tint)}>
        <meta.icon className="tracking-anim h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold text-ink">{headline}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
      {children}
    </Card>
  );
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export function FeatureMock({ feature, on }: { feature: Feature; on: boolean }) {
  switch (feature) {
    case "feeds":
      return (
        <div className="tracking-mock" data-on={on}>
          <StatusCard icon={featureMeta("feeds").icon} label={t("Last feed")} time={minutesAgo(80)} detail={`120 ml · ${t("bottle")}`} sub={`6 ${t("feeds")} · 540 ml ${t("today")}`} tintClass="text-feed" />
        </div>
      );
    case "diapers":
      return (
        <div className="tracking-mock" data-on={on}>
          <StatusCard icon={featureMeta("diapers").icon} label={t("Last diaper")} time={minutesAgo(35)} detail={t("wet")} sub={`3 ${t("wet")} · 1 ${t("dirty")} · 1 ${t("both")}`} tintClass="text-diaper" />
        </div>
      );
    case "sleep":
      return <Row feature="sleep" on={on} headline={`${t("Sleeping")} · 42 min`} detail={t("Tap Wake when she is up")} />;
    case "pump":
      return <Row feature="pump" on={on} headline="12:40" detail={`90 ml ${t("today")}`} />;
    case "medicine":
      return <Row feature="medicine" on={on} headline="Paracet 2,5 ml" detail={`${t("next dose OK from")} 16:30`} />;
    case "measurements":
      return <Row feature="measurements" on={on} headline="5,4 kg" detail={`${t("~")}50${t(". percentile (WHO)")}`} />;
    case "milestones":
      return <Row feature="milestones" on={on} headline={t("First smile")} detail={t("with a photo")} />;
    case "bath":
      return <Row feature="bath" on={on} headline={t("Bath")} detail={`${t("Last")} ${t("yesterday")}`} />;
    case "notes":
      return <Row feature="notes" on={on} headline={t("Slept in the pram")} detail="14:05" />;
    case "play":
      return <Row feature="play" on={on} headline={`${t("Tummy time")} · 08:12`} detail={t("running")} />;
    case "daycare":
      return <Row feature="daycare" on={on} headline={t("At daycare")} detail={`${t("Pick-up")} 15:30 · Anne`} />;
    case "illness":
      return <Row feature="illness" on={on} headline={t("Ill since Monday")} detail={`48 ${t("h")} ${t("symptom-free by")} ${t("tomorrow")} 09:00`} />;
    case "vaccines":
      return <Row feature="vaccines" on={on} headline={t("3 months: Rotavirus")} detail={t("due this week")} />;
  }
}
```

Reuse strings the dictionary already has where possible (`Last feed`, `Last diaper`, `wet`, `feeds`, `today`, `Sleeping`, `Tummy time`, `At daycare`, `Pick-up`, `next dose OK from`); grep `i18n.ts` before inventing one, and add Norwegian for the new ones.

- [ ] **Step 4: The card** — `components/tracking/TrackingCard.tsx`

```tsx
import { useState } from "react";
import type { FeatureMeta } from "@/lib/tracking";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";
import { FeatureMock } from "./mocks";

const tintVar: Record<string, string> = {
  "text-feed": "var(--color-feed)",
  "text-sleep": "var(--color-sleep)",
  "text-diaper": "var(--color-diaper)",
  "text-growth": "var(--color-growth)",
  "text-accent": "var(--color-accent)",
  "text-muted": "var(--color-muted)",
};

// One card per switch (spec §The carousel): the live mock, the title, one
// line, the toggle, a tag. Off is asleep — mock desaturated, title muted;
// turning on is the light-up (styles.css): the tint returns, the mock
// plays its one animation, a ring in the tint pulses from the toggle,
// and the phone ticks once. Off just dims: tidying, not losing.
export function TrackingCard({ meta, on, tag, readOnly, onToggle }: {
  meta: FeatureMeta;
  on: boolean;
  tag: string | null;
  readOnly: boolean;
  onToggle: (next: boolean) => void;
}) {
  // A counter, not a boolean: re-arms the one-shot animation on every flip on.
  const [lit, setLit] = useState(0);
  const toggle = () => {
    const next = !on;
    if (next) {
      setLit((n) => n + 1);
      try {
        navigator.vibrate?.(10);
      } catch {
        // not every browser has it
      }
    }
    onToggle(next);
  };
  const Icon = meta.icon;
  return (
    <section
      className="flex h-full w-full shrink-0 snap-center flex-col justify-between px-4"
      data-testid={`tracking-card-${meta.key}`}
      aria-label={t(meta.label)}
    >
      <div className={cn("space-y-4 pt-6", !on && "tracking-off")}>
        <FeatureMock feature={meta.key} on={on} />
        <div className="flex items-center gap-2">
          <Icon className={cn("h-6 w-6", on ? meta.tint : "text-muted")} />
          <h2 className={cn("text-2xl font-extrabold", on ? "text-ink" : "text-muted")}>{t(meta.label)}</h2>
        </div>
        <p className="text-base text-ink-soft">{t(meta.description)}</p>
        {tag && <p className="text-sm font-semibold text-accent">{tag}</p>}
      </div>
      <div className="flex items-center justify-between py-4">
        <span className="text-sm font-semibold text-muted">{on ? t("On") : t("Off")}</span>
        {readOnly ? (
          <span className="text-sm font-bold text-ink">{on ? t("On") : t("Off")}</span>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={t(meta.label)}
            onClick={toggle}
            key={lit}
            style={{ "--ping-color": tintVar[meta.tint] ?? "var(--color-accent)" } as React.CSSProperties}
            className={cn(
              "relative h-11 w-20 rounded-full border transition-colors",
              on ? "border-accent bg-accent" : "border-line bg-surface-2",
              lit > 0 && on && "animate-tracking-lit",
              focusRing,
            )}
          >
            <span
              className={cn(
                "absolute top-1 h-8 w-8 rounded-full bg-white shadow transition-transform",
                on ? "left-1 translate-x-9" : "left-1",
              )}
            />
          </button>
        )}
      </div>
    </section>
  );
}
```

`data-on` lives on the mock root (test asserts it). If `focusRing` is not exported from `@/lib/utils`, check `HomeActions.tsx`'s import and copy.

- [ ] **Step 5: The CSS** — append to `styles.css` after `.animate-help-wave`

```css
/* The tracking carousel (components/tracking/): off is asleep, on lights
   up. The mock dims through a filter so any component inside reads the
   same; .tracking-anim is the one part that moves, once, when the switch
   comes on. The ring reuses ring-ping in the card's category tint (set as
   --ping-color by TrackingCard), so night mode's amber comes through. */
.tracking-mock {
  transition: filter 0.4s ease, opacity 0.4s ease;
}
.tracking-mock[data-on="false"] {
  filter: grayscale(1);
  opacity: 0.45;
}
@keyframes tracking-pop {
  0% {
    transform: scale(0.8);
  }
  55% {
    transform: scale(1.15);
  }
  100% {
    transform: scale(1);
  }
}
.tracking-mock[data-on="true"] .tracking-anim {
  animation: tracking-pop 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) 1;
}
.animate-tracking-lit {
  --ping-start: 60%;
  --ping-spread: 16px;
  animation: ring-ping 0.4s ease-out 1;
}
```

And inside the existing `@media (prefers-reduced-motion: reduce)` block:

```css
  .tracking-mock[data-on="true"] .tracking-anim,
  .animate-tracking-lit {
    animation: none;
  }
```

(The `filter`/`opacity` transition is what remains: the crossfade. The block's `* { transition-duration: 0.01ms }` makes it instant there, which is the reduced-motion contract.)

- [ ] **Step 6: The carousel** — `components/tracking/TrackingCarousel.tsx`

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { Baby, Feature } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSetBabyFeatures } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatAge } from "@/lib/time";
import { ageMonths, featureCards, recommended, recommendedByAge, useTracking } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { TrackingCard } from "./TrackingCard";

// One card per switch, then a summary (spec §The carousel). A scroll-snap
// strip with Back / Next as the primary control — the app's no-swipe rule
// is about ROUTE navigation fighting the back gesture; swiping here is a
// bonus nobody needs. Every flip saves at once (optimistic on the babies
// list), so leaving mid-way keeps what was chosen; Done only navigates.
export function TrackingCarousel({ baby, isAdmin, isNew }: { baby: Baby; isAdmin: boolean; isNew: boolean }) {
  const navigate = useNavigate();
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const track = useTracking(baby);
  const save = useSetBabyFeatures();
  const months = ageMonths(new Date(baby.birthDate));
  const last = featureCards.length; // the summary's index

  const goTo = (i: number) => {
    const el = strip.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setIndex(i);
  };
  const onScroll = () => {
    const el = strip.current;
    if (!el || el.clientWidth === 0) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };
  const set = (features: Feature[]) => save.mutate({ babyId: baby.id, features });
  const flip = (key: Feature, on: boolean) =>
    set(on ? [...baby.features, key] : baby.features.filter((k) => k !== key));
  const done = () => (isNew ? navigate({ to: "/home" }) : navigate({ to: "/settings/baby/$babyId", params: { babyId: baby.id } }));

  return (
    <div className="flex min-h-dvh flex-col">
      <div ref={strip} onScroll={onScroll} className="flex flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain scroll-smooth [scrollbar-width:none]" data-testid="tracking-strip">
        {featureCards.map((meta, i) => (
          <div key={meta.key} className="flex w-full shrink-0 snap-center flex-col">
            {i === 0 && isNew && isAdmin && (
              <Card className="mx-4 mt-4 space-y-2 text-center">
                <p className="text-sm text-ink-soft">{t("Swipe through what Pjokk can track, or take the set we suggest for a baby of")} {formatAge(new Date(baby.birthDate))}.</p>
                <Button size="full" onClick={() => { set(recommended(months)); goTo(last); }} data-testid="use-recommended">
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
                    ? `${t("Recommended for")} ${baby.name}${t("'s age")}`
                    : null
              }
              readOnly={!isAdmin}
              onToggle={(on) => flip(meta.key, on)}
            />
          </div>
        ))}
        <section className="flex w-full shrink-0 snap-center flex-col justify-center gap-4 px-4" data-testid="tracking-summary" aria-label={t("Summary")}>
          <h2 className="text-2xl font-extrabold text-ink">{t("Tracking for")} {baby.name}</h2>
          {track.any ? (
            <ul className="space-y-2">
              {featureCards.filter((m) => track.has(m.key)).map((m) => (
                <li key={m.key} className="flex items-center gap-2 font-semibold text-ink">
                  <m.icon className={cn("h-5 w-5", m.tint)} />
                  {t(m.label)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-soft">{t("Nothing tracked yet")}</p>
          )}
          <p className="text-sm text-muted">{t("Change this any time under Settings.")}</p>
        </section>
      </div>
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-safe">
        <Button variant="outline" onClick={() => goTo(index - 1)} disabled={index === 0}>{t("Back")}</Button>
        <div className="flex gap-1" aria-hidden>
          {Array.from({ length: last + 1 }, (_, i) => (
            <span key={i} className={cn("h-1.5 w-1.5 rounded-full", i === index ? "bg-accent" : "bg-line")} />
          ))}
        </div>
        {index < last ? (
          <Button onClick={() => goTo(index + 1)} data-testid="tracking-next">{t("Next")}</Button>
        ) : (
          <Button onClick={() => void done()} data-testid="tracking-done">{t("Done")}</Button>
        )}
      </div>
    </div>
  );
}
```

`pb-safe`: check `styles.css` for the safe-area utility name used elsewhere (`pt-safe` exists; the Kiosk uses `pb-safe`).

- [ ] **Step 7: The page and route**

`screens/settings/TrackingPage.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { TrackingCarousel } from "@/components/tracking/TrackingCarousel";
import { useBabies, useMe } from "@/lib/data";
import { t } from "@/lib/i18n";

// Settings → <baby> → What to track, and the step right after adding a
// baby (?new=1 makes Done go to Home).
export function TrackingPage({ babyId, isNew }: { babyId: string; isNew: boolean }) {
  const me = useMe();
  const babies = useBabies();
  const role = me.data?.memberRole;
  const isAdmin = role === "admin" || role === "owner";
  const baby = babies.data?.find((b) => b.id === babyId);
  if (!baby) {
    return babies.isPending ? null : (
      <p className="p-6 text-sm text-muted">
        {t("Page not found")} <Link to="/settings" className="font-semibold text-accent">{t("Back")}</Link>
      </p>
    );
  }
  return <TrackingCarousel baby={baby} isAdmin={isAdmin} isNew={isNew} />;
}
```

`router.tsx`, after `settingsBabyRoute`:

```ts
const settingsBabyTrackingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/baby/$babyId/tracking",
  validateSearch: (search: Record<string, unknown>): { new?: boolean } =>
    search.new === true || search.new === "1" || search.new === 1 ? { new: true } : {},
  component: function BabyTrackingRoute() {
    const { babyId } = settingsBabyTrackingRoute.useParams();
    const { new: isNew } = settingsBabyTrackingRoute.useSearch();
    return <TrackingPage key={babyId} babyId={babyId} isNew={!!isNew} />;
  },
});
```

Add it to the route tree list next to `settingsBabyRoute`. If `test/router.test.ts` pins the route list, add the path there.

- [ ] **Step 8: The two add-baby flows**

`Welcome.tsx` `createBaby`: capture the response and navigate to the carousel:

```ts
const created = await unwrap<Baby>(client.POST("/api/babies", { body: { … } }));
await queryClient.invalidateQueries();
void navigate({ to: "/settings/baby/$babyId/tracking", params: { babyId: created.id }, search: { new: true } });
```

`BabySheet.tsx`: `save` returns the baby; in `onSuccess`, when `!baby` (a create), navigate the same way after `done()`. `useNavigate` from `@tanstack/react-router`.

- [ ] **Step 9: Norwegian** — `lib/i18n.ts`, a new `// What to track (per-baby switches)` block: every label, description, group title, tag fragment, button and line introduced in Tasks 5–8 (`Feeds`, `Pumping`, `Growth and temperature`, `Milestones`, `Baths`, `Notes`, `Play`, `Barnehage`, `Illness`, `Vaccines`, each description, `Everyday`, `Health`, `Extras`, `On`, `Off`, `Next`, `Done`, `Use the recommended set`, `Recommended for`, `'s age`, `Recommended if`, `goes to barnehage`, `Tracking for`, `Change this any time under Settings.`, `Summary`, the mock strings). Run `node scripts/check-i18n.mjs` to list what is missing; it is the authority.

- [ ] **Step 10: Run everything on the TypeScript side**

Run: `bun run check 2>&1 | tail -5 && cd apps/frontend && bun test 2>&1 | tail -5`
Expected: clean and PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/frontend
git commit -m "feat(frontend): the what-to-track carousel — cards, live mocks, the light-up

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end tests and the fixture

**Files:**
- Modify: `e2e/helpers.ts` (`uiCreateFamily`)
- Modify: `e2e/baby-header.spec.ts` (the Add baby from Settings test)
- Modify: `e2e/layout.spec.ts`
- Create: `e2e/tracking.spec.ts`

- [ ] **Step 1: The fixture tracks everything**

In `uiCreateFamily`, after clicking Add baby, the app now lands on the carousel. Every existing spec assumes an "existing" baby (everything on), so the fixture sets that through the API before going where the caller expects:

```ts
  await page.getByRole("button", { name: "Add baby" }).click();
  // The app now goes to the what-to-track carousel (or, for an enrolled
  // kiosk, straight to /kiosk). Every spec wants the "existing baby"
  // state — everything tracked, as the 00033 backfill leaves a
  // deployment's babies — so set it through the API and move on. The
  // carousel itself is e2e/tracking.spec.ts's business.
  await expect(page).not.toHaveURL(/\/welcome/, { timeout: 10_000 });
  const babies = await (await page.request.get("/api/babies")).json();
  for (const b of babies) {
    const res = await page.request.put(`/api/babies/${b.id}/features`, { data: { features: ALL_FEATURES } });
    if (!res.ok()) throw new Error(`features: ${res.status()} ${await res.text()}`);
  }
  await page.goto(landing.source.includes("kiosk") ? "/kiosk" : "/home");
  await expect(page).toHaveURL(landing, { timeout: 10_000 });
```

with `export const ALL_FEATURES = ["feeds","pump","sleep","diapers","medicine","measurements","milestones","bath","notes","play","daycare","illness","vaccines"];` at the top of `helpers.ts`. Check every caller of `uiCreateFamily` / `freshFamily` that passes a `landing` (grep) still lands.

- [ ] **Step 2: baby-header.spec** — after `Save` in "a second baby joins the row", the sheet now goes to the carousel:

```ts
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/settings\/baby\/[^/]+\/tracking/);
  await page.getByTestId("use-recommended").click();
  await page.getByTestId("tracking-done").click();
  await expect(page).toHaveURL(/\/home/);
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /Oskar/ })).toBeVisible();
```

- [ ] **Step 3: `e2e/tracking.spec.ts`**

```ts
import { expect, test } from "./fixtures";
import { ALL_FEATURES, apiSignIn, apiSignup, enrolKiosk, freshEmail, freshFamily, openBabySettings } from "./helpers";

// Per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md).

test("a new baby chooses on the carousel; the recommended set reflows Home", async ({ page, request }) => {
  const email = freshEmail("tracking-new");
  await apiSignup(request, email);
  await apiSignIn(page, email);
  await page.goto("/");
  await page.getByPlaceholder(/Family name/).fill("The tracking family");
  await page.getByRole("button", { name: "Create family" }).click();
  await expect(page.getByText("Who are we tracking?")).toBeVisible();
  await page.getByPlaceholder("Baby's name").fill("Ida");
  const born = new Date();
  born.setMonth(born.getMonth() - 3); // three months old: the newborn band
  await page.getByLabel("Birth date").fill(born.toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Add baby" }).click();

  await expect(page).toHaveURL(/\/settings\/baby\/[^/]+\/tracking\?new=/);
  await expect(page.getByTestId("tracking-card-feeds")).toBeVisible();
  await page.getByTestId("use-recommended").click();
  const summary = page.getByTestId("tracking-summary");
  await expect(summary).toContainText("Feeds");
  await expect(summary).toContainText("Sleep");
  await expect(summary).toContainText("Diapers");
  await expect(summary).toContainText("Growth and temperature");
  await expect(summary).not.toContainText("Milestones");
  await page.getByTestId("tracking-done").click();

  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole("button", { name: "Feed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diaper" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sleep" })).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("button", { name: "Measurement" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Medicine" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask for help" })).toBeVisible();
});

test("switching Feeds off hides its entry points and keeps its history", async ({ page, request }) => {
  await freshFamily(page, request, "tracking-off");
  // One feed on the record first.
  await page.getByRole("button", { name: "Feed" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Last feed/)).toBeVisible();

  await openBabySettings(page);
  await page.getByRole("link", { name: /What to track/ }).click();
  await expect(page).toHaveURL(/\/tracking$/);
  const feeds = page.getByTestId("tracking-card-feeds").getByRole("switch");
  await expect(feeds).toHaveAttribute("aria-checked", "true");
  await feeds.click();
  await expect(feeds).toHaveAttribute("aria-checked", "false");

  await page.goto("/home");
  await expect(page.getByRole("button", { name: "Diaper" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feed" })).toHaveCount(0);
  await expect(page.getByText(/Last feed/)).toHaveCount(0);

  await page.goto("/timeline");
  await expect(page.getByRole("button", { name: "Diapers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feeds" })).toHaveCount(0);
  await expect(page.getByText(/bottle/i).first()).toBeVisible(); // the old feed, under All

  await page.goto("/stats");
  await expect(page.getByText(/Sleep \/ day/)).toBeVisible();
  await expect(page.getByText(/Intake/)).toHaveCount(0);

  await page.goto("/profile");
  await page.getByRole("button", { name: "Add reminder" }).click();
  await expect(page.getByRole("button", { name: "Diaper", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Feed", exact: true })).toHaveCount(0);
});

test("the kiosk hides a card whose switch is off", async ({ page, request }) => {
  await freshFamily(page, request, "tracking-kiosk");
  const [baby] = await (await page.request.get("/api/babies")).json();
  await page.request.put(`/api/babies/${baby.id}/features`, {
    data: { features: ALL_FEATURES.filter((f) => f !== "diapers") },
  });
  await enrolKiosk(page);
  await expect(page.getByTestId("kiosk-feed")).toBeVisible();
  await expect(page.getByTestId("kiosk-sleep")).toBeVisible();
  await expect(page.getByTestId("kiosk-diaper")).toHaveCount(0);
});
```

Adjust the reminder-sheet locator to how `reminders.spec.ts` opens it, and the feed-sheet Save to how `feed.spec.ts` logs one (copy their lines). If `enrolKiosk` needs Settings, check `kiosk.spec.ts`'s order and mirror it.

- [ ] **Step 4: layout.spec reflow** — add one test that runs on every project:

```ts
test("the primaries reflow when a switch is off", async ({ page, request }) => {
  await freshFamily(page, request, "reflow");
  const [baby] = await (await page.request.get("/api/babies")).json();
  await page.request.put(`/api/babies/${baby.id}/features`, { data: { features: ["feeds", "sleep", "medicine"] } });
  await page.goto("/home");
  await expect(page.getByRole("button", { name: "Feed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diaper" })).toHaveCount(0);
  const feed = await page.getByRole("button", { name: "Feed" }).boundingBox();
  const sleep = await page.getByRole("button", { name: "Sleep" }).boundingBox();
  expect(feed && sleep && Math.abs(feed.y - sleep.y) < 2).toBe(true); // one row
});
```

- [ ] **Step 5: Run the e2e suite**

Build the stack and run per the repo's scripts (`scripts/e2e-stack.sh`; Go on PATH in that shell; never run the Go suite meanwhile): `bun run typecheck && npx playwright test --config e2e/playwright.config.ts --workers=2 2>&1 | tail -15`
Expected: all green, including the existing specs through the changed fixture.

- [ ] **Step 6: Commit**

```bash
git add e2e
git commit -m "test(e2e): the carousel, switching Feeds off, the kiosk and the reflow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (Information architecture, after the Settings bullet)
- Modify: `DECISIONS.md` (a new dated section at the end)
- Modify: `docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md` (one correction)

- [ ] **Step 1: Spec correction** — the Home bullet says "More disappears when no More-kind is on". Ask for help always lives in More, so More stays whenever the grid is shown; the grid itself is replaced by the nothing-tracked card when the set is empty. Rewrite that sentence to: "More stays, since Ask for help lives there; the whole grid gives way to the nothing-tracked card when the set is empty."

- [ ] **Step 2: CLAUDE.md** — add a bullet under Information architecture:

```
- **What to track (per baby, spec `docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md`):**
  `baby.features` is the ENABLED keys of thirteen switches (`feeds, pump,
  sleep, diapers, medicine, measurements, milestones, bath, notes, play,
  daycare, illness, vaccines`), all on for a baby that predates the
  column, none for a new one until the carousel
  (`/settings/baby/$babyId/tracking`, `components/tracking/`) runs right
  after creation with a set recommended from the birth date
  (`lib/tracking.ts` `recommended`). Off HIDES entry points — the Home
  button and card, the More tile, the timeline chip, the Stats card, the
  Settings row, the reminder kind, the kiosk card — and never history,
  never a write: `PUT /api/babies/{id}/features` is admin-only and not a
  device operation, the server gates nothing on it, and the only server
  readers are the reminder job (holds) and the closing alert (skips).
  Every screen asks `useTracking(baby).has(key)`; nothing reads the
  array. Family-wide things (Calendar, Contacts, help, keys) have no
  switch.
```

- [ ] **Step 3: DECISIONS.md** — append:

```
## 2026-09-17 — what to track: per-baby switches, a carousel, a light-up

The owner's partner: the app "has grown to include way too much". One set
of thirteen switches per baby (spec
`docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md`).

- **Hide the entry points, keep the history** (owner: option 1 of three).
  Off removes the button, tile, chip, card, row, reminder kind and kiosk
  card; the timeline's All still shows what was logged, the export is
  untouched, and the server accepts every write. A switch is a
  preference, not a permission — the alternative turned "hide" into a
  gate, and the codebase has spent a year removing those.
- **Admins only** (owner). The family agrees on one app.
- **Per baby, not per family, this round** (owner). Calendar, Contacts,
  help and keys keep no switch; the Family page's shared lists follow
  the union of the babies' switches.
- **The recommendation is derived, never asked.** The birth date is
  already typed; "straight out of hospital" is a question we can answer.
  Bands at 4 and 12 months; a barnehage child keeps diapers (she is one
  and in them until two or three) and drops feeds; barnehage is a fact,
  not an age, so its card carries its own tag.
- **A carousel with buttons, not a wizard, not one screen.** The owner
  wanted a card per feature with an illustration; the app's no-swipe
  rule is about route navigation, so the strip snaps and Back / Next
  drive it. "Use the recommended set" on card one is the 3 a.m. path.
- **The illustration is the feature.** Mocks built from the app's own
  components, not artwork: thirteen animations would double the bundle
  and need a night version each. One CSS animation per card.
- **The light-up.** Off is desaturated and dimmed; on returns the tint,
  plays the mock once, pulses one ring in the category tint from the
  toggle, and ticks the phone once. Off just dims. Reduced motion keeps
  the crossfade and the haptic.
- **A column, not a table.** `features text[]`, backfilled to everything:
  no restore, backup or deletion rule to add, and a whole-set PUT is
  idempotent for an offline replay.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md DECISIONS.md docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md
git commit -m "docs: what to track, per-baby switches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Full verification and the PR

- [ ] **Step 1: Read `.github/workflows/test.yml` and `ci.yml`** and list every step; run each locally, gating on exit codes, not on grepped output.
- [ ] **Step 2: Go:** `cd apps/server && go vet ./... && golangci-lint run ./... && TEST_DATABASE_URL=… go test -p 1 ./... 2>&1 | tail -20` → every package `ok`.
- [ ] **Step 3: TypeScript:** `bun run check && bun run test` from the root → exit 0.
- [ ] **Step 4: e2e:** the full Playwright run from Task 9 (not concurrently with Step 2).
- [ ] **Step 5: Push and open the PR** (`gh pr create`), body: what and why, the spec link, the test evidence, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Watch CI by parsing `gh pr checks <n>` (no `--json` on the local gh).
