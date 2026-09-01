package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Active sleep sessions — ports apps/api/test/sleep.test.ts's "active sleep
// sessions" describe block.
// -----------------------------------------------------------------------

func TestSleepStartActiveWakeInactive(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	start := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
	})
	if start.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", start.Status, start.Raw)
	}
	if start.JSON["endTime"] != nil {
		t.Errorf("endTime = %v, want nil (active session)", start.JSON["endTime"])
	}
	sessionID, _ := start.JSON["id"].(string)

	active := a.Do(http.MethodGet, "/api/sleep/active?babyId="+babyID, cookie, nil)
	if active.Status != http.StatusOK {
		t.Fatalf("GET active status = %d, body %s", active.Status, active.Raw)
	}
	if active.JSON["id"] != sessionID {
		t.Errorf("active session id = %v, want %q", active.JSON["id"], sessionID)
	}

	wake := a.Do(http.MethodPost, "/api/sleep/"+sessionID+"/wake", cookie, map[string]any{})
	if wake.Status != http.StatusOK {
		t.Fatalf("wake status = %d, body %s", wake.Status, wake.Raw)
	}
	if wake.JSON["endTime"] == nil {
		t.Errorf("endTime after wake = nil, want a timestamp")
	}

	after := a.Do(http.MethodGet, "/api/sleep/active?babyId="+babyID, cookie, nil)
	if after.Status != http.StatusOK {
		t.Fatalf("GET active (after wake) status = %d, body %s", after.Status, after.Raw)
	}
	if string(after.Raw) != "null" {
		t.Errorf("GET active (after wake) body = %q, want bare JSON null", after.Raw)
	}
	if after.JSON != nil {
		t.Errorf("GET active (after wake) JSON = %v, want nil", after.JSON)
	}
}

func TestCreateSleepUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    "does-not-exist",
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestCreateSleepRefusesSecondActiveSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	body := map[string]any{"babyId": babyID, "startTime": time.Now().UTC().Format(time.RFC3339)}

	first := a.Do(http.MethodPost, "/api/sleep", cookie, body)
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}

	second := a.Do(http.MethodPost, "/api/sleep", cookie, body)
	if second.Status != http.StatusConflict {
		t.Fatalf("second POST status = %d, body %s, want 409", second.Status, second.Raw)
	}
	if second.JSON["error"] != "Already sleeping" || second.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("body = %v, want {error:\"Already sleeping\",code:\"ALREADY_ACTIVE\"}", second.JSON)
	}
}

// The DB-race path defects.test.ts covered: bypass the app's own pre-check
// by inserting an active session directly, then POST through the API — the
// partial unique index must still turn this into 409 ALREADY_ACTIVE, not a
// raw 500 from an unhandled 23505.
func TestCreateSleepActiveSessionDBEnforcedRace(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	ctx := context.Background()

	var caretakerID string
	if err := a.Rig.Pool.QueryRow(ctx,
		`SELECT "user_id" FROM "organization_members" WHERE "organization_id" = $1 LIMIT 1`, familyID,
	).Scan(&caretakerID); err != nil {
		t.Fatalf("find the admin's user id: %v", err)
	}
	if _, err := a.Rig.Pool.Exec(ctx, `
		INSERT INTO "sleep_log" ("family_id", "baby_id", "caretaker_id", "start_time", "end_time")
		VALUES ($1, $2, $3, now(), NULL)`,
		familyID, babyID, caretakerID); err != nil {
		t.Fatalf("seed an active sleep_log row directly: %v", err)
	}

	res := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if res.Status != http.StatusConflict {
		t.Fatalf("status = %d, body %s, want 409", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Already sleeping" || res.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("body = %v, want {error:\"Already sleeping\",code:\"ALREADY_ACTIVE\"}", res.JSON)
	}
}

func TestWakeTwiceIsNoOpErrorNotDataCorruption(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	sessionID, _ := created.JSON["id"].(string)

	endTime := time.Now().UTC().Format(time.RFC3339)
	first := a.Do(http.MethodPost, "/api/sleep/"+sessionID+"/wake", cookie, map[string]any{"endTime": endTime})
	if first.Status != http.StatusOK {
		t.Fatalf("first wake status = %d, body %s", first.Status, first.Raw)
	}

	second := a.Do(http.MethodPost, "/api/sleep/"+sessionID+"/wake", cookie, map[string]any{
		"endTime": time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	})
	if second.Status != http.StatusNotFound {
		t.Fatalf("second wake status = %d, body %s, want 404", second.Status, second.Raw)
	}
	if second.JSON["error"] != "No such active session" || second.JSON["code"] != "NOT_FOUND" {
		t.Errorf("second wake body = %v, want {error:\"No such active session\",code:\"NOT_FOUND\"}", second.JSON)
	}

	list := a.DoArray(http.MethodGet, "/api/sleep?babyId="+babyID, cookie, nil)
	row := list.JSON[0].(map[string]any)
	// endTime survives with the value the FIRST wake set, not the second's.
	got, _ := row["endTime"].(string)
	want, err := time.Parse(time.RFC3339, endTime)
	if err != nil {
		t.Fatalf("parse endTime: %v", err)
	}
	gotT, err := time.Parse(time.RFC3339, got)
	if err != nil {
		t.Fatalf("parse row endTime %q: %v", got, err)
	}
	if !gotT.Equal(want) {
		t.Errorf("endTime = %v, want the first wake's %v (second wake must be a no-op)", gotT, want)
	}
}

// -----------------------------------------------------------------------
// PATCH /api/sleep/{id} — tri-state clear/reopen and its 409.
// -----------------------------------------------------------------------

func TestUpdateSleepSetsClearsAndLeavesFields(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
		"location":  "Crib",
		"notes":     "fussy",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	// Clear location and notes; leave startTime/endTime untouched.
	cleared := a.Do(http.MethodPatch, "/api/sleep/"+id, cookie, map[string]any{
		"location": nil,
		"notes":    nil,
	})
	if cleared.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", cleared.Status, cleared.Raw)
	}
	if cleared.JSON["location"] != nil || cleared.JSON["notes"] != nil {
		t.Errorf("location/notes after clear = %v/%v, want nil/nil", cleared.JSON["location"], cleared.JSON["notes"])
	}
	if cleared.JSON["startTime"] != created.JSON["startTime"] {
		t.Errorf("startTime after unrelated clear = %v, want unchanged %v", cleared.JSON["startTime"], created.JSON["startTime"])
	}

	// An empty patch is a no-op.
	noop := a.Do(http.MethodPatch, "/api/sleep/"+id, cookie, map[string]any{})
	if noop.Status != http.StatusOK {
		t.Fatalf("empty PATCH status = %d, body %s", noop.Status, noop.Raw)
	}
	if noop.JSON["endTime"] != cleared.JSON["endTime"] {
		t.Errorf("endTime after empty PATCH = %v, want unchanged %v", noop.JSON["endTime"], cleared.JSON["endTime"])
	}
}

func TestUpdateSleepClearEndTimeReopensSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	reopened := a.Do(http.MethodPatch, "/api/sleep/"+id, cookie, map[string]any{"endTime": nil})
	if reopened.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", reopened.Status, reopened.Raw)
	}
	if reopened.JSON["endTime"] != nil {
		t.Errorf("endTime after clearing = %v, want nil (reopened)", reopened.JSON["endTime"])
	}

	active := a.Do(http.MethodGet, "/api/sleep/active?babyId="+babyID, cookie, nil)
	if active.JSON["id"] != id {
		t.Errorf("active session id = %v, want the reopened session %q", active.JSON["id"], id)
	}
}

func TestUpdateSleepClearEndTimeConflictsWithAnotherActiveSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// A completed session…
	completed := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
	})
	if completed.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", completed.Status, completed.Raw)
	}
	completedID, _ := completed.JSON["id"].(string)

	// …and a currently active one for the SAME baby.
	active := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
	})
	if active.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", active.Status, active.Raw)
	}

	// Reopening the completed one must 409: the baby already has an active
	// session.
	res := a.Do(http.MethodPatch, "/api/sleep/"+completedID, cookie, map[string]any{"endTime": nil})
	if res.Status != http.StatusConflict {
		t.Fatalf("status = %d, body %s, want 409", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Already sleeping" || res.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("body = %v, want {error:\"Already sleeping\",code:\"ALREADY_ACTIVE\"}", res.JSON)
	}
}

func TestUpdateSleepUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPatch, "/api/sleep/does-not-exist", cookie, map[string]any{"notes": "x"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

// -----------------------------------------------------------------------
// DELETE /api/sleep/{id}
// -----------------------------------------------------------------------

func TestDeleteSleepRemovesItAndUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
	})
	id, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodDelete, "/api/sleep/"+id, cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("DELETE status = %d, body %s", del.Status, del.Raw)
	}
	if del.JSON["ok"] != true {
		t.Errorf("DELETE body = %v, want {ok:true}", del.JSON)
	}

	again := a.Do(http.MethodDelete, "/api/sleep/"+id, cookie, nil)
	if again.Status != http.StatusNotFound {
		t.Fatalf("second DELETE status = %d, body %s, want 404", again.Status, again.Raw)
	}
}

// -----------------------------------------------------------------------
// Listing: newest-first ordering and caretakerName.
// -----------------------------------------------------------------------

func TestListSleepsNewestFirstWithCaretakerName(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 1, 1, 20, 0, 0, 0, time.UTC)
	first := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": t0.Format(time.RFC3339),
		"endTime":   t0.Add(30 * time.Minute).Format(time.RFC3339),
	})
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	if first.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q", first.JSON["caretakerName"], "Rig admin")
	}

	second := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": t0.Add(time.Hour).Format(time.RFC3339),
		"endTime":   t0.Add(90 * time.Minute).Format(time.RFC3339),
	})
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", second.Status, second.Raw)
	}

	list := a.DoArray(http.MethodGet, "/api/sleep?babyId="+babyID, cookie, nil)
	if len(list.JSON) != 2 {
		t.Fatalf("GET /api/sleep = %v, want 2", list.JSON)
	}
	newest := list.JSON[0].(map[string]any)
	if newest["id"] != second.JSON["id"] {
		t.Errorf("newest-first: first row id = %v, want the later session %v", newest["id"], second.JSON["id"])
	}
}

// -----------------------------------------------------------------------
// Family scoping — ports tenancy.test.ts's shape for sleep.
// -----------------------------------------------------------------------

func TestSleepsAreFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/sleep", cookieA, map[string]any{
		"babyId":    babyA,
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	sleepID, _ := created.JSON["id"].(string)

	listA := a.DoArray(http.MethodGet, "/api/sleep", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/sleep", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B list = %v, want 0", listB.JSON)
	}

	patch := a.Do(http.MethodPatch, "/api/sleep/"+sleepID, cookieB, map[string]any{"notes": "nope"})
	if patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	del := a.Do(http.MethodDelete, "/api/sleep/"+sleepID, cookieB, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	activeCrossFamily := a.Do(http.MethodGet, "/api/sleep/active?babyId="+babyA, cookieB, nil)
	if activeCrossFamily.Status != http.StatusOK {
		t.Fatalf("cross-family GET active status = %d, body %s", activeCrossFamily.Status, activeCrossFamily.Raw)
	}
	if string(activeCrossFamily.Raw) != "null" {
		t.Errorf("cross-family GET active body = %q, want bare JSON null (family B has no such baby)", activeCrossFamily.Raw)
	}

	crossCreate := a.Do(http.MethodPost, "/api/sleep", cookieB, map[string]any{
		"babyId":    babyA,
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if crossCreate.Status != http.StatusNotFound {
		t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
	}
}

func TestSleepRejectsUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/sleep", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}
