package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Tenancy — Task 22's belt-and-braces sweep. Ports apps/api/test/
// tenancy.test.ts's five `it` blocks verbatim (below), then extends far
// past that file's Phase-1-only scope: every route class the Go backend
// grew across Tasks 9-21 gets its own cross-family probe here too, even
// where the route's own _test.go file already asserts the identical case
// (feeds_test.go, other_logs_test.go, sleep_test.go, play_test.go,
// sleep_locations_test.go, calendar_test.go, contacts_test.go,
// timeline_test.go, summary_test.go, stats_test.go, files_test.go,
// invites_test.go, keys_test.go, babies_test.go, push_test.go). The point
// of this file is a single place proving the tenancy promise end to end
// across the WHOLE surface, table-driven where the routes share a shape,
// rather than trusting that promise to hold only because it was checked
// once per route.
//
// The tenancy promise: no request, however crafted, reads or writes another
// family's rows.
// -----------------------------------------------------------------------

// --- 1:1 ports of tenancy.test.ts's five `it` blocks ---

func TestTenancyRejectsUnauthenticatedRequest(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/feeds", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, body %s, want 401", res.Status, res.Raw)
	}
}

func TestTenancyRejectsSignedInUserWithNoFamily(t *testing.T) {
	a := testrig.App(t)
	loner := a.SignUp("No family", "loner@example.com")
	_ = loner
	cookie := a.SignIn("loner@example.com")

	res := a.Do(http.MethodGet, "/api/babies", cookie, nil)
	if res.Status != http.StatusForbidden {
		t.Fatalf("status = %d, body %s, want 403", res.Status, res.Raw)
	}
	if res.JSON["code"] != "NO_FAMILY" {
		t.Errorf("code = %v, want NO_FAMILY", res.JSON["code"])
	}
}

func TestTenancyScopesListsToActiveFamily(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/feeds", cookieA, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339),
		"type": "bottle", "amountMl": 120,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}

	listA := a.DoArray(http.MethodGet, "/api/feeds", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/feeds", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A feed list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B feed list = %v, want 0", listB.JSON)
	}

	babies := a.DoArray(http.MethodGet, "/api/babies", cookieA, nil)
	if len(babies.JSON) != 1 || babies.JSON[0].(map[string]any)["id"] != babyA {
		t.Errorf("family A babies = %v, want exactly [%q]", babies.JSON, babyA)
	}
}

func TestTenancyBlocksCrossFamilyReadsAndWritesById(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/feeds", cookieA, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339),
		"type": "bottle", "amountMl": 100,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	// B tries to update / delete A's feed by id.
	if patch := a.Do(http.MethodPatch, "/api/feeds/"+id, cookieB, map[string]any{"amountMl": 999}); patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	if del := a.Do(http.MethodDelete, "/api/feeds/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	// Still intact for A.
	fromA := a.DoArray(http.MethodGet, "/api/feeds", cookieA, nil)
	if len(fromA.JSON) != 1 || fromA.JSON[0].(map[string]any)["amountMl"] != float64(100) {
		t.Errorf("family A feeds after refused hijack = %v, want one row with amountMl 100", fromA.JSON)
	}
}

func TestTenancyBlocksLoggingAgainstAnotherFamilysBaby(t *testing.T) {
	a := testrig.App(t)
	familyA, _ := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	res := a.Do(http.MethodPost, "/api/feeds", cookieB, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339), "type": "bottle",
	})
	if res.Status != http.StatusNotFound {
		t.Errorf("cross-family create status = %d, want 404", res.Status)
	}

	summary := a.Do(http.MethodGet, "/api/summary?babyId="+babyA, cookieB, nil)
	if summary.Status != http.StatusNotFound {
		t.Errorf("cross-family summary status = %d, want 404", summary.Status)
	}
}

// Ports "verifies membership, not just the session's active org claim":
// sign in first (session captures the active family), THEN remove the
// membership row directly. The stale session claim must not grant access —
// see internal/api/middleware/middleware.go's RequireFamily doc comment
// ("an activeOrganizationId alone is not proof, because it survives the
// member being removed") and middleware_test.go's own version of this case;
// this is the tenancy suite's copy of the same guarantee.
func TestTenancyRejectsStaleActiveFamilyClaimWithoutMembership(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")

	if _, err := a.Rig.Pool.Exec(context.Background(),
		`DELETE FROM "organization_members" WHERE "organization_id" = $1`, familyA,
	); err != nil {
		t.Fatalf("delete membership row: %v", err)
	}

	res := a.Do(http.MethodGet, "/api/babies", cookieA, nil)
	if res.Status != http.StatusForbidden {
		t.Fatalf("status = %d, body %s, want 403", res.Status, res.Raw)
	}
	if res.JSON["code"] != "NOT_MEMBER" {
		t.Errorf("code = %v, want NOT_MEMBER", res.JSON["code"])
	}
}

// --- The sweep: every route class Task 9-21 added ---

// simpleLogKind describes one "create under a baby, list/patch/delete by
// id" resource — the shape feeds, diapers, sleep and the six Phase-3 kinds
// (medicine, baths, notes, milestones, measurements, pumps) plus vaccines
// all share.
type simpleLogKind struct {
	base      string
	timeField string // "time" for most kinds, "startTime" for sleep
	extra     map[string]any
}

func simpleLogKinds() []simpleLogKind {
	return []simpleLogKind{
		{"feeds", "time", map[string]any{"type": "bottle", "amountMl": 100}},
		{"diapers", "time", map[string]any{"type": "wet"}},
		{"sleep", "startTime", map[string]any{}},
		{"medicine", "time", map[string]any{"name": "Paracet"}},
		{"baths", "time", map[string]any{}},
		{"notes", "time", map[string]any{"content": "First taste of banana."}},
		{"milestones", "time", map[string]any{"title": "Stood unsupported"}},
		{"measurements", "time", map[string]any{"type": "weight", "value": 8.4}},
		{"pumps", "time", map[string]any{"side": "left", "amountMl": float64(90), "durationMin": float64(15)}},
		{"vaccines", "time", map[string]any{"name": "MMR", "doseNumber": float64(1), "scheduleSlot": "mmr:1"}},
	}
}

// TestTenancySweepSimpleLogKinds is the table-driven core of the sweep:
// across every simple log resource, prove list scoping, cross-family 404 by
// id (PATCH and DELETE), the row surviving the refused hijack, and refusal
// to log against another family's baby.
func TestTenancySweepSimpleLogKinds(t *testing.T) {
	for _, k := range simpleLogKinds() {
		t.Run(k.base, func(t *testing.T) {
			a := testrig.App(t)
			familyA, cookieA := a.NewFamily("Family A", "a@example.com")
			_, cookieB := a.NewFamily("Family B", "b@example.com")
			babyA := a.NewBaby(familyA, "Baby A")

			body := map[string]any{"babyId": babyA, k.timeField: time.Now().UTC().Format(time.RFC3339)}
			for key, v := range k.extra {
				body[key] = v
			}

			created := a.Do(http.MethodPost, "/api/"+k.base, cookieA, body)
			if created.Status != http.StatusCreated {
				t.Fatalf("POST /api/%s status = %d, body %s", k.base, created.Status, created.Raw)
			}
			id, _ := created.JSON["id"].(string)

			listA := a.DoArray(http.MethodGet, "/api/"+k.base, cookieA, nil)
			listB := a.DoArray(http.MethodGet, "/api/"+k.base, cookieB, nil)
			if len(listA.JSON) != 1 {
				t.Errorf("family A list = %v, want 1", listA.JSON)
			}
			if len(listB.JSON) != 0 {
				t.Errorf("family B list = %v, want 0 (family-scoped)", listB.JSON)
			}

			if patch := a.Do(http.MethodPatch, "/api/"+k.base+"/"+id, cookieB, map[string]any{}); patch.Status != http.StatusNotFound {
				t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
			}
			if del := a.Do(http.MethodDelete, "/api/"+k.base+"/"+id, cookieB, nil); del.Status != http.StatusNotFound {
				t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
			}

			stillA := a.DoArray(http.MethodGet, "/api/"+k.base, cookieA, nil)
			if len(stillA.JSON) != 1 {
				t.Errorf("family A list after refused hijack = %v, want still 1 (untouched)", stillA.JSON)
			}

			crossCreate := a.Do(http.MethodPost, "/api/"+k.base, cookieB, body)
			if crossCreate.Status != http.StatusNotFound {
				t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
			}
		})
	}
}

// TestTenancySweepPlay covers play's start/stop shape, which the generic
// simpleLogKind table above can't express (create/patch/stop/delete plus an
// /active probe, not create/patch/delete alone).
func TestTenancySweepPlay(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/play", cookieA, map[string]any{
		"babyId": babyA, "type": "tummy",
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	listA := a.DoArray(http.MethodGet, "/api/play", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/play", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B list = %v, want 0", listB.JSON)
	}

	if patch := a.Do(http.MethodPatch, "/api/play/"+id, cookieB, map[string]any{}); patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	if stop := a.Do(http.MethodPost, "/api/play/"+id+"/stop", cookieB, map[string]any{}); stop.Status != http.StatusNotFound {
		t.Errorf("cross-family stop status = %d, want 404", stop.Status)
	}
	if del := a.Do(http.MethodDelete, "/api/play/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
	active := a.Do(http.MethodGet, "/api/play/active?babyId="+babyA, cookieB, nil)
	if active.Status != http.StatusOK || string(active.Raw) != "null" {
		t.Errorf("cross-family GET active = %d %q, want 200 null", active.Status, active.Raw)
	}
}

// TestTenancySweepSleepLocations covers the one admin-gated, non-baby-scoped
// resource: custom sleep-location chips are family-wide, not per-baby.
func TestTenancySweepSleepLocations(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/sleep-locations", cookieA, map[string]any{"name": "Hammock"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	listB := a.DoArray(http.MethodGet, "/api/sleep-locations", cookieB, nil)
	for _, row := range listB.JSON {
		if row.(map[string]any)["name"] == "Hammock" {
			t.Fatalf("family B's sleep-location list leaked family A's custom chip: %v", listB.JSON)
		}
	}

	if del := a.Do(http.MethodDelete, "/api/sleep-locations/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
}

// TestTenancySweepCalendarEvents covers the premium calendar's cross-family
// isolation (list within the query window, and by-id PATCH/DELETE).
func TestTenancySweepCalendarEvents(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookieA, map[string]any{
		"title": "Ours", "category": "family", "startTime": futureISO(hour), "allDay": true,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	listB := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(time.Now(), time.Now().Add(48*hour)), cookieB, nil)
	if len(listB.JSON) != 0 {
		t.Errorf("family B's calendar list = %v, want empty (family-scoped)", listB.JSON)
	}

	if patch := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookieB, map[string]any{"title": "Hijack"}); patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	if del := a.Do(http.MethodDelete, "/api/calendar/events/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
}

// TestTenancySweepContacts covers the family address book's isolation.
func TestTenancySweepContacts(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/contacts", cookieA, map[string]any{"name": "Dr. Hansen"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	listB := a.DoArray(http.MethodGet, "/api/contacts", cookieB, nil)
	if len(listB.JSON) != 0 {
		t.Errorf("family B's contacts list = %v, want empty (family-scoped)", listB.JSON)
	}

	if patch := a.Do(http.MethodPatch, "/api/contacts/"+id, cookieB, map[string]any{"name": "Hijack"}); patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	if del := a.Do(http.MethodDelete, "/api/contacts/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
}

// TestTenancySweepTimelineForeignBabyId probes the merged timeline endpoint
// with another family's babyId.
func TestTenancySweepTimelineForeignBabyId(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	if res := a.Do(http.MethodPost, "/api/feeds", cookieA, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339), "type": "bottle",
	}); res.Status != http.StatusCreated {
		t.Fatalf("seed feed status = %d, body %s", res.Status, res.Raw)
	}

	res := a.Do(http.MethodGet, "/api/timeline?babyId="+babyA, cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("timeline with another family's babyId status = %d, want 404", res.Status)
	}
}

// TestTenancySweepSummaryForeignBabyId probes /api/summary with another
// family's babyId.
func TestTenancySweepSummaryForeignBabyId(t *testing.T) {
	a := testrig.App(t)
	familyA, _ := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyA, cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("summary with another family's babyId status = %d, want 404", res.Status)
	}
}

// TestTenancySweepStatsForeignBabyId probes /api/stats with another family's
// babyId.
func TestTenancySweepStatsForeignBabyId(t *testing.T) {
	a := testrig.App(t)
	familyA, _ := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyA+"&tz=0", cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("stats with another family's babyId status = %d, want 404", res.Status)
	}
}

// TestTenancySweepFiles probes /api/files/{id} (get and delete) with a
// document seeded under a different family. Reuses files_test.go's
// seedVaccineDocument/pngBytes/adminUserID helpers (same package).
func TestTenancySweepFiles(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	babyA := a.NewBaby(familyA, "Baby A")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/vaccines", cookieA, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST vaccine status = %d, body %s", created.Status, created.Raw)
	}
	vaccineID, _ := created.JSON["id"].(string)
	docID := seedVaccineDocument(t, a, familyA, vaccineID, "vaccine-docs/"+familyA+"/tenancy-sweep", "card.png", "image/png", pngBytes())

	if res := a.Do(http.MethodGet, "/api/files/"+docID, cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("cross-family GET status = %d, want 404", res.Status)
	}
	if del := a.Do(http.MethodDelete, "/api/files/"+docID, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
}

// TestTenancySweepInvites probes invite list scoping and cross-family
// revoke by code.
func TestTenancySweepInvites(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookieA, map[string]any{})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	code, _ := created.JSON["code"].(string)

	listB := a.DoArray(http.MethodGet, "/api/invites", cookieB, nil)
	if len(listB.JSON) != 0 {
		t.Errorf("family B's invite list = %v, want empty", listB.JSON)
	}
	if revoke := a.Do(http.MethodDelete, "/api/invites/"+code, cookieB, nil); revoke.Status != http.StatusNotFound {
		t.Errorf("cross-family revoke status = %d, want 404", revoke.Status)
	}

	listA := a.DoArray(http.MethodGet, "/api/invites", cookieA, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A's invite list after refused cross-family revoke = %v, want still 1", listA.JSON)
	}
}

// TestTenancySweepKeys probes API-key list scoping and cross-family delete
// by id.
func TestTenancySweepKeys(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/keys", cookieA, map[string]any{"name": "HA"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	listB := a.DoArray(http.MethodGet, "/api/keys", cookieB, nil)
	if len(listB.JSON) != 0 {
		t.Errorf("family B's key list = %v, want empty", listB.JSON)
	}
	if del := a.Do(http.MethodDelete, "/api/keys/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family delete status = %d, want 404", del.Status)
	}

	listA := a.DoArray(http.MethodGet, "/api/keys", cookieA, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A's key list after refused cross-family delete = %v, want still 1", listA.JSON)
	}
}

// TestTenancySweepMemberManagementForeignMemberId is a NEW probe (Task 22):
// prior member-management tests (babies_test.go's
// TestSetMemberRoleUnknownMemberIs404 / TestDeleteFamilyMemberUnknownMemberIs404)
// only used a nonexistent id string, never a REAL memberId belonging to a
// different family. That is a meaningfully different case — a real id that
// resolves to a row, just not one in the caller's own family — so it
// exercises internal/auth's actual family-scoped lookup
// (auth.go's RemoveMember/SetMemberRole, both keyed on
// gen.GetFamilyMemberParams{OrganizationID: familyID, ID: memberID}) rather
// than a 404 that a route could accidentally return for ANY unknown string.
func TestTenancySweepMemberManagementForeignMemberId(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	membersA := a.DoArray(http.MethodGet, "/api/family/members", cookieA, nil)
	if len(membersA.JSON) != 1 {
		t.Fatalf("family A members = %v, want exactly 1 (the admin)", membersA.JSON)
	}
	memberIDA, _ := membersA.JSON[0].(map[string]any)["memberId"].(string)
	if memberIDA == "" {
		t.Fatalf("family A admin's memberId missing from %v", membersA.JSON)
	}

	roleChange := a.Do(http.MethodPost, "/api/family/members/"+memberIDA+"/role", cookieB, map[string]any{"role": "admin"})
	if roleChange.Status != http.StatusNotFound {
		t.Errorf("cross-family role change status = %d, body %s, want 404 (not found in B's family, not a leak)", roleChange.Status, roleChange.Raw)
	}
	remove := a.Do(http.MethodDelete, "/api/family/members/"+memberIDA, cookieB, nil)
	if remove.Status != http.StatusNotFound {
		t.Errorf("cross-family remove status = %d, body %s, want 404", remove.Status, remove.Raw)
	}

	// A's membership is untouched by B's failed attempts.
	stillA := a.DoArray(http.MethodGet, "/api/family/members", cookieA, nil)
	if len(stillA.JSON) != 1 {
		t.Errorf("family A members after refused cross-family attempts = %v, want still 1", stillA.JSON)
	}
	if stillA.JSON[0].(map[string]any)["role"] != "admin" {
		t.Errorf("family A admin's role = %v, want still admin (untouched by B's role-change attempt)", stillA.JSON[0].(map[string]any)["role"])
	}
}

// TestTenancySweepPushEndpointOwnership extends push_test.go's
// TestUnsubscribeScopedToOwnRows (same family, different user) across a
// family boundary too: family B's admin "unsubscribing" family A's push
// endpoint must not touch A's row. Unsubscribe is scoped by (endpoint,
// callerUserId) — see internal/api/push.go's UnsubscribePush — so this
// also proves that scope holds across families, not merely across users
// within one.
func TestTenancySweepPushEndpointOwnership(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	endpoint := "https://fcm.googleapis.com/sub/tenancy-sweep"
	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookieA, subscribeBody(endpoint)); res.Status != http.StatusOK {
		t.Fatalf("subscribe status = %d, body %s", res.Status, res.Raw)
	}

	// B "unsubscribing" A's endpoint is still 200 (a set-membership
	// operation, not a lookup) but must not delete A's row.
	res := a.Do(http.MethodPost, "/api/push/unsubscribe", cookieB, map[string]any{"endpoint": endpoint})
	if res.Status != http.StatusOK {
		t.Fatalf("cross-family unsubscribe status = %d, body %s", res.Status, res.Raw)
	}
	var count int
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "push_subscription" WHERE "endpoint" = $1`, endpoint,
	).Scan(&count); err != nil {
		t.Fatalf("count subscription: %v", err)
	}
	if count != 1 {
		t.Errorf("family A's subscription survived cross-family unsubscribe? rows = %d, want 1", count)
	}
}
