package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Running play sessions — ports apps/api/test/play.test.ts's "play
// sessions" describe block, minus the premium gate (create is free on this
// port — see internal/api/play.go's divergence 3).
// -----------------------------------------------------------------------

func TestPlayStartRunningStopInactive(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	start := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "tummy",
		"startTime": time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
	})
	if start.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", start.Status, start.Raw)
	}
	if start.JSON["endTime"] != nil {
		t.Errorf("endTime = %v, want nil (running session)", start.JSON["endTime"])
	}
	if start.JSON["type"] != "tummy" {
		t.Errorf("type = %v, want %q", start.JSON["type"], "tummy")
	}
	sessionID, _ := start.JSON["id"].(string)

	active := a.Do(http.MethodGet, "/api/play/active?babyId="+babyID, cookie, nil)
	if active.Status != http.StatusOK {
		t.Fatalf("GET active status = %d, body %s", active.Status, active.Raw)
	}
	if active.JSON["id"] != sessionID {
		t.Errorf("active session id = %v, want %q", active.JSON["id"], sessionID)
	}

	stop := a.Do(http.MethodPost, "/api/play/"+sessionID+"/stop", cookie, map[string]any{})
	if stop.Status != http.StatusOK {
		t.Fatalf("stop status = %d, body %s", stop.Status, stop.Raw)
	}
	if stop.JSON["endTime"] == nil {
		t.Errorf("endTime after stop = nil, want a timestamp")
	}

	after := a.Do(http.MethodGet, "/api/play/active?babyId="+babyID, cookie, nil)
	if after.Status != http.StatusOK {
		t.Fatalf("GET active (after stop) status = %d, body %s", after.Status, after.Raw)
	}
	if string(after.Raw) != "null" {
		t.Errorf("GET active (after stop) body = %q, want bare JSON null", after.Raw)
	}
	if after.JSON != nil {
		t.Errorf("GET active (after stop) JSON = %v, want nil", after.JSON)
	}
}

// A completed entry (endTime supplied at create) is not "active" — logging
// one retroactively must not touch a baby's ability to also start a timer.
func TestCreatePlayRetroactiveDoesNotBlockActive(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	end := time.Now()
	start := end.Add(-20 * time.Minute)

	created := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "walk",
		"startTime": start.UTC().Format(time.RFC3339),
		"endTime":   end.UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["endTime"] == nil {
		t.Errorf("endTime = nil, want a timestamp (completed entry)")
	}

	active := a.Do(http.MethodGet, "/api/play/active?babyId="+babyID, cookie, nil)
	if string(active.Raw) != "null" {
		t.Errorf("GET active body = %q, want bare JSON null (no running session)", active.Raw)
	}
}

func TestCreatePlayUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    "does-not-exist",
		"type":      "tummy",
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestCreatePlayRefusesSecondRunningSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	body := map[string]any{"babyId": babyID, "type": "tummy", "startTime": time.Now().UTC().Format(time.RFC3339)}

	first := a.Do(http.MethodPost, "/api/play", cookie, body)
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}

	second := a.Do(http.MethodPost, "/api/play", cookie, body)
	if second.Status != http.StatusConflict {
		t.Fatalf("second POST status = %d, body %s, want 409", second.Status, second.Raw)
	}
	if second.JSON["error"] != "Already active" || second.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("body = %v, want {error:\"Already active\",code:\"ALREADY_ACTIVE\"}", second.JSON)
	}
}

// Two babies in the same family each get their own running session — the
// partial unique index is scoped per baby_id, not per family.
func TestCreatePlayAllowsRunningSessionPerBabyIndependently(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyA := a.NewBaby(familyID, "Nora")
	babyB := a.NewBaby(familyID, "Sibling")
	startTime := time.Now().UTC().Format(time.RFC3339)

	for _, id := range []string{babyA, babyB} {
		res := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
			"babyId": id, "type": "tummy", "startTime": startTime,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("POST for baby %q status = %d, body %s", id, res.Status, res.Raw)
		}
	}
}

// The DB-race path defects.test.ts covered for sleep: bypass the app's own
// pre-check by inserting a running session directly, then POST through the
// API — the partial unique index must still turn this into 409
// ALREADY_ACTIVE, not a raw 500 from an unhandled 23505.
func TestCreatePlayRunningSessionDBEnforcedRace(t *testing.T) {
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
		INSERT INTO "play_log" ("family_id", "baby_id", "caretaker_id", "type", "start_time", "end_time")
		VALUES ($1, $2, $3, 'tummy', now(), NULL)`,
		familyID, babyID, caretakerID); err != nil {
		t.Fatalf("seed a running play_log row directly: %v", err)
	}

	res := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "walk",
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if res.Status != http.StatusConflict {
		t.Fatalf("status = %d, body %s, want 409", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Already active" || res.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("body = %v, want {error:\"Already active\",code:\"ALREADY_ACTIVE\"}", res.JSON)
	}
}

func TestStopPlayTwiceIsNoOpErrorNotDataCorruption(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "walk",
		"startTime": time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	sessionID, _ := created.JSON["id"].(string)

	endTime := time.Now().UTC().Format(time.RFC3339)
	first := a.Do(http.MethodPost, "/api/play/"+sessionID+"/stop", cookie, map[string]any{"endTime": endTime})
	if first.Status != http.StatusOK {
		t.Fatalf("first stop status = %d, body %s", first.Status, first.Raw)
	}

	second := a.Do(http.MethodPost, "/api/play/"+sessionID+"/stop", cookie, map[string]any{
		"endTime": time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	})
	if second.Status != http.StatusNotFound {
		t.Fatalf("second stop status = %d, body %s, want 404", second.Status, second.Raw)
	}
	if second.JSON["error"] != "No such running session" || second.JSON["code"] != "NOT_FOUND" {
		t.Errorf("second stop body = %v, want {error:\"No such running session\",code:\"NOT_FOUND\"}", second.JSON)
	}

	list := a.DoArray(http.MethodGet, "/api/play?babyId="+babyID, cookie, nil)
	row := list.JSON[0].(map[string]any)
	// endTime survives with the value the FIRST stop set, not the second's.
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
		t.Errorf("endTime = %v, want the first stop's %v (second stop must be a no-op)", gotT, want)
	}
}

// Stopping frees the per-baby slot: a new running session can start right
// after.
func TestStopPlayFreesSlotForNewRunningSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	body := map[string]any{"babyId": babyID, "type": "tummy", "startTime": time.Now().UTC().Format(time.RFC3339)}
	first := a.Do(http.MethodPost, "/api/play", cookie, body)
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	id, _ := first.JSON["id"].(string)

	stop := a.Do(http.MethodPost, "/api/play/"+id+"/stop", cookie, map[string]any{})
	if stop.Status != http.StatusOK {
		t.Fatalf("stop status = %d, body %s", stop.Status, stop.Raw)
	}

	second := a.Do(http.MethodPost, "/api/play", cookie, body)
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s, want 201 (slot freed)", second.Status, second.Raw)
	}
}

func TestStopPlayUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/play/does-not-exist/stop", cookie, map[string]any{})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

// -----------------------------------------------------------------------
// PATCH /api/play/{id} — tri-state clear/reopen and its 409.
// -----------------------------------------------------------------------

func TestUpdatePlaySetsClearsAndLeavesFields(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "tummy",
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
		"notes":     "fussy",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	// Set type; clear notes; leave startTime/endTime untouched.
	updated := a.Do(http.MethodPatch, "/api/play/"+id, cookie, map[string]any{
		"type":  "walk",
		"notes": nil,
	})
	if updated.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", updated.Status, updated.Raw)
	}
	if updated.JSON["type"] != "walk" {
		t.Errorf("type after set = %v, want %q", updated.JSON["type"], "walk")
	}
	if updated.JSON["notes"] != nil {
		t.Errorf("notes after clear = %v, want nil", updated.JSON["notes"])
	}
	if updated.JSON["startTime"] != created.JSON["startTime"] {
		t.Errorf("startTime after unrelated update = %v, want unchanged %v", updated.JSON["startTime"], created.JSON["startTime"])
	}

	// An empty patch is a no-op.
	noop := a.Do(http.MethodPatch, "/api/play/"+id, cookie, map[string]any{})
	if noop.Status != http.StatusOK {
		t.Fatalf("empty PATCH status = %d, body %s", noop.Status, noop.Raw)
	}
	if noop.JSON["endTime"] != updated.JSON["endTime"] {
		t.Errorf("endTime after empty PATCH = %v, want unchanged %v", noop.JSON["endTime"], updated.JSON["endTime"])
	}
}

func TestUpdatePlayClearEndTimeReopensSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "tummy",
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	reopened := a.Do(http.MethodPatch, "/api/play/"+id, cookie, map[string]any{"endTime": nil})
	if reopened.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", reopened.Status, reopened.Raw)
	}
	if reopened.JSON["endTime"] != nil {
		t.Errorf("endTime after clearing = %v, want nil (reopened)", reopened.JSON["endTime"])
	}

	active := a.Do(http.MethodGet, "/api/play/active?babyId="+babyID, cookie, nil)
	if active.JSON["id"] != id {
		t.Errorf("active session id = %v, want the reopened session %q", active.JSON["id"], id)
	}
}

func TestUpdatePlayClearEndTimeConflictsWithAnotherRunningSession(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// A completed session…
	completed := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "tummy",
		"startTime": time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
	})
	if completed.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", completed.Status, completed.Raw)
	}
	completedID, _ := completed.JSON["id"].(string)

	// …and a currently running one for the SAME baby.
	running := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "walk",
		"startTime": time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
	})
	if running.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", running.Status, running.Raw)
	}

	// Reopening the completed one must 409: the baby already has a running
	// session.
	res := a.Do(http.MethodPatch, "/api/play/"+completedID, cookie, map[string]any{"endTime": nil})
	if res.Status != http.StatusConflict {
		t.Fatalf("status = %d, body %s, want 409", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Already active" || res.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("body = %v, want {error:\"Already active\",code:\"ALREADY_ACTIVE\"}", res.JSON)
	}
}

func TestUpdatePlayUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPatch, "/api/play/does-not-exist", cookie, map[string]any{"notes": "x"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

// -----------------------------------------------------------------------
// DELETE /api/play/{id}
// -----------------------------------------------------------------------

func TestDeletePlayRemovesItAndUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "tummy",
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
	})
	id, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodDelete, "/api/play/"+id, cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("DELETE status = %d, body %s", del.Status, del.Raw)
	}
	if del.JSON["ok"] != true {
		t.Errorf("DELETE body = %v, want {ok:true}", del.JSON)
	}

	again := a.Do(http.MethodDelete, "/api/play/"+id, cookie, nil)
	if again.Status != http.StatusNotFound {
		t.Fatalf("second DELETE status = %d, body %s, want 404", again.Status, again.Raw)
	}
}

// -----------------------------------------------------------------------
// Listing: newest-first ordering and caretakerName.
// -----------------------------------------------------------------------

func TestListPlaysNewestFirstWithCaretakerName(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 1, 1, 20, 0, 0, 0, time.UTC)
	first := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "tummy",
		"startTime": t0.Format(time.RFC3339),
		"endTime":   t0.Add(30 * time.Minute).Format(time.RFC3339),
	})
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	if first.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q", first.JSON["caretakerName"], "Rig admin")
	}

	second := a.Do(http.MethodPost, "/api/play", cookie, map[string]any{
		"babyId":    babyID,
		"type":      "walk",
		"startTime": t0.Add(time.Hour).Format(time.RFC3339),
		"endTime":   t0.Add(90 * time.Minute).Format(time.RFC3339),
	})
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", second.Status, second.Raw)
	}

	list := a.DoArray(http.MethodGet, "/api/play?babyId="+babyID, cookie, nil)
	if len(list.JSON) != 2 {
		t.Fatalf("GET /api/play = %v, want 2", list.JSON)
	}
	newest := list.JSON[0].(map[string]any)
	if newest["id"] != second.JSON["id"] {
		t.Errorf("newest-first: first row id = %v, want the later session %v", newest["id"], second.JSON["id"])
	}
}

// -----------------------------------------------------------------------
// Family scoping — ports tenancy.test.ts's shape for play.
// -----------------------------------------------------------------------

func TestPlaysAreFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/play", cookieA, map[string]any{
		"babyId":    babyA,
		"type":      "tummy",
		"startTime": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().UTC().Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	playID, _ := created.JSON["id"].(string)

	listA := a.DoArray(http.MethodGet, "/api/play", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/play", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B list = %v, want 0", listB.JSON)
	}

	patch := a.Do(http.MethodPatch, "/api/play/"+playID, cookieB, map[string]any{"notes": "nope"})
	if patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	stop := a.Do(http.MethodPost, "/api/play/"+playID+"/stop", cookieB, map[string]any{})
	if stop.Status != http.StatusNotFound {
		t.Errorf("cross-family stop status = %d, want 404", stop.Status)
	}
	del := a.Do(http.MethodDelete, "/api/play/"+playID, cookieB, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	activeCrossFamily := a.Do(http.MethodGet, "/api/play/active?babyId="+babyA, cookieB, nil)
	if activeCrossFamily.Status != http.StatusOK {
		t.Fatalf("cross-family GET active status = %d, body %s", activeCrossFamily.Status, activeCrossFamily.Raw)
	}
	if string(activeCrossFamily.Raw) != "null" {
		t.Errorf("cross-family GET active body = %q, want bare JSON null (family B has no such baby)", activeCrossFamily.Raw)
	}

	crossCreate := a.Do(http.MethodPost, "/api/play", cookieB, map[string]any{
		"babyId":    babyA,
		"type":      "tummy",
		"startTime": time.Now().UTC().Format(time.RFC3339),
	})
	if crossCreate.Status != http.StatusNotFound {
		t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
	}
}

func TestPlayRejectsUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/play", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}
