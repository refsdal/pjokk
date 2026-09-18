package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Days at barnehage (issue #105, internal/api/daycare.go). No TypeScript
// ancestor: the lifecycle tests mirror play_test.go's, and the rest cover
// what a day at barnehage has that a play session does not — a second
// person, and a reopen that forgets them.
// -----------------------------------------------------------------------

func rfc(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func TestDaycareDropOffThenPickUp(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a

	drop := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{
		"babyId":    w.babyID,
		"startTime": rfc(time.Now().Add(-7 * time.Hour)),
	})
	if drop.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", drop.Status, drop.Raw)
	}
	if drop.JSON["endTime"] != nil || drop.JSON["pickupCaretakerId"] != nil {
		t.Errorf("running session = %v, want endTime and pickupCaretakerId null", drop.JSON)
	}
	if drop.JSON["caretakerId"] != w.adminID || drop.JSON["loggedById"] != w.adminID {
		t.Errorf("drop-off people = %v / %v, want the caller twice", drop.JSON["caretakerId"], drop.JSON["loggedById"])
	}
	id, _ := drop.JSON["id"].(string)

	active := a.Do(http.MethodGet, "/api/daycare/active?babyId="+w.babyID, w.cookie, nil)
	if active.JSON["id"] != id {
		t.Errorf("active id = %v, want %q", active.JSON["id"], id)
	}
	summary := a.Do(http.MethodGet, "/api/summary?babyId="+w.babyID, w.cookie, nil)
	if day, _ := summary.JSON["activeDaycare"].(map[string]any); day == nil || day["id"] != id {
		t.Errorf("summary.activeDaycare = %v, want the running session", summary.JSON["activeDaycare"])
	}

	// The partner picks up: the pick-up person defaults to the caller.
	pickup := a.Do(http.MethodPost, "/api/daycare/"+id+"/pickup", w.partner, nil)
	if pickup.Status != http.StatusOK {
		t.Fatalf("pickup status = %d, body %s", pickup.Status, pickup.Raw)
	}
	if pickup.JSON["endTime"] == nil {
		t.Errorf("endTime after pickup = nil, want a timestamp")
	}
	if pickup.JSON["pickupCaretakerId"] != w.memberID || pickup.JSON["pickupCaretakerName"] != "Bo Hansen" {
		t.Errorf("pick-up person = %v (%v), want the partner", pickup.JSON["pickupCaretakerId"], pickup.JSON["pickupCaretakerName"])
	}
	if pickup.JSON["caretakerId"] != w.adminID {
		t.Errorf("drop-off person after pickup = %v, want unchanged", pickup.JSON["caretakerId"])
	}

	after := a.Do(http.MethodGet, "/api/daycare/active?babyId="+w.babyID, w.cookie, nil)
	if string(after.Raw) != "null" {
		t.Errorf("GET active after pickup = %q, want bare JSON null", after.Raw)
	}
	summary = a.Do(http.MethodGet, "/api/summary?babyId="+w.babyID, w.cookie, nil)
	if v, present := summary.JSON["activeDaycare"]; !present || v != nil {
		t.Errorf("summary.activeDaycare after pickup = %v (present %v), want an explicit null", v, present)
	}

	// A replayed pick-up must not move the end or rename who came.
	again := a.Do(http.MethodPost, "/api/daycare/"+id+"/pickup", w.cookie, nil)
	if again.Status != http.StatusNotFound {
		t.Errorf("second pickup status = %d, want 404", again.Status)
	}
	list := a.DoArray(http.MethodGet, "/api/daycare?babyId="+w.babyID, w.cookie, nil)
	if len(list.JSON) != 1 || list.JSON[0].(map[string]any)["pickupCaretakerId"] != w.memberID {
		t.Errorf("list after replay = %v, want one row still picked up by the partner", list.JSON)
	}
}

func TestDaycarePickUpNamesSomeoneElseAndATime(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	start := time.Now().Add(-8 * time.Hour).Truncate(time.Second)
	end := start.Add(7 * time.Hour)

	drop := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{"babyId": w.babyID, "startTime": rfc(start)})
	id, _ := drop.JSON["id"].(string)

	pickup := a.Do(http.MethodPost, "/api/daycare/"+id+"/pickup", w.cookie, map[string]any{
		"endTime": rfc(end), "caretakerId": w.memberID,
	})
	if pickup.Status != http.StatusOK {
		t.Fatalf("pickup status = %d, body %s", pickup.Status, pickup.Raw)
	}
	if pickup.JSON["pickupCaretakerId"] != w.memberID {
		t.Errorf("pickupCaretakerId = %v, want the named partner", pickup.JSON["pickupCaretakerId"])
	}
	if got, _ := time.Parse(time.RFC3339, pickup.JSON["endTime"].(string)); !got.Equal(end) {
		t.Errorf("endTime = %v, want %v", got, end)
	}
}

func TestDaycareRefusesASecondRunningSession(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	body := map[string]any{"babyId": babyID, "startTime": rfc(time.Now())}

	if first := a.Do(http.MethodPost, "/api/daycare", cookie, body); first.Status != http.StatusCreated {
		t.Fatalf("first status = %d, body %s", first.Status, first.Raw)
	}
	second := a.Do(http.MethodPost, "/api/daycare", cookie, body)
	if second.Status != http.StatusConflict || second.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("second = %d %v, want 409 ALREADY_ACTIVE", second.Status, second.JSON)
	}

	// Another baby of the same family is its own session.
	sibling := a.NewBaby(familyID, "Emil")
	if res := a.Do(http.MethodPost, "/api/daycare", cookie, map[string]any{"babyId": sibling, "startTime": rfc(time.Now())}); res.Status != http.StatusCreated {
		t.Errorf("sibling drop-off = %d, want 201", res.Status)
	}
	// Asleep at barnehage: a running sleep session is independent state.
	if res := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{"babyId": babyID, "startTime": rfc(time.Now())}); res.Status != http.StatusCreated {
		t.Errorf("sleep while at daycare = %d, body %s, want 201", res.Status, res.Raw)
	}
}

func TestDaycareFinishedDayLoggedAfterTheFact(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	end := time.Now().Add(-time.Hour)

	day := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{
		"babyId":            w.babyID,
		"startTime":         rfc(end.Add(-7 * time.Hour)),
		"endTime":           rfc(end),
		"caretakerId":       w.memberID,
		"pickupCaretakerId": w.adminID,
		"notes":             "Planning day tomorrow",
	})
	if day.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", day.Status, day.Raw)
	}
	if day.JSON["caretakerId"] != w.memberID || day.JSON["pickupCaretakerId"] != w.adminID || day.JSON["loggedById"] != w.adminID {
		t.Errorf("people = %v, want dropped off by the partner, picked up and logged by the caller", day.JSON)
	}
	if active := a.Do(http.MethodGet, "/api/daycare/active?babyId="+w.babyID, w.cookie, nil); string(active.Raw) != "null" {
		t.Errorf("a finished day reads as active: %s", active.Raw)
	}
	// And it does not stop today's drop-off.
	if res := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{"babyId": w.babyID, "startTime": rfc(time.Now())}); res.Status != http.StatusCreated {
		t.Errorf("drop-off after a finished day = %d, want 201", res.Status)
	}
}

// A drop-off has had no pick-up: the field is ignored there, not stored.
func TestDaycareDropOffIgnoresAPickUpPerson(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	res := w.a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{
		"babyId": w.babyID, "startTime": rfc(time.Now()), "pickupCaretakerId": w.memberID,
	})
	if res.Status != http.StatusCreated || res.JSON["pickupCaretakerId"] != nil {
		t.Errorf("drop-off = %d %v, want 201 with pickupCaretakerId null", res.Status, res.JSON["pickupCaretakerId"])
	}
}

func TestDaycareStrangersAreRefusedEverywhere(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	stranger := a.SignUp("Stranger", "stranger@example.com")
	now := time.Now()

	for name, body := range map[string]map[string]any{
		"drop-off person": {"babyId": w.babyID, "startTime": rfc(now), "caretakerId": stranger},
		"pick-up person":  {"babyId": w.babyID, "startTime": rfc(now.Add(-time.Hour)), "endTime": rfc(now), "pickupCaretakerId": stranger},
	} {
		if res := a.Do(http.MethodPost, "/api/daycare", w.cookie, body); res.Status != http.StatusForbidden || res.JSON["code"] != "NOT_MEMBER" {
			t.Errorf("create with a stranger as %s = %d %v, want 403 NOT_MEMBER", name, res.Status, res.JSON)
		}
	}

	drop := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{"babyId": w.babyID, "startTime": rfc(now)})
	id, _ := drop.JSON["id"].(string)
	if res := a.Do(http.MethodPost, "/api/daycare/"+id+"/pickup", w.cookie, map[string]any{"caretakerId": stranger}); res.Status != http.StatusForbidden {
		t.Errorf("pickup by a stranger = %d, want 403", res.Status)
	}
	if res := a.Do(http.MethodPatch, "/api/daycare/"+id, w.cookie, map[string]any{"pickupCaretakerId": stranger}); res.Status != http.StatusForbidden {
		t.Errorf("patch naming a stranger = %d, want 403", res.Status)
	}
	if active := a.Do(http.MethodGet, "/api/daycare/active?babyId="+w.babyID, w.cookie, nil); active.JSON["id"] != id {
		t.Errorf("a refused pickup ended the session: %s", active.Raw)
	}
}

func TestDaycarePatchPeopleTimesAndReopen(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	end := time.Now().Add(-time.Hour).Truncate(time.Second)
	day := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{
		"babyId": w.babyID, "startTime": rfc(end.Add(-6 * time.Hour)), "endTime": rfc(end), "pickupCaretakerId": w.adminID,
	})
	id, _ := day.JSON["id"].(string)

	patched := a.Do(http.MethodPatch, "/api/daycare/"+id, w.cookie, map[string]any{
		"pickupCaretakerId": w.memberID, "caretakerId": w.memberID, "notes": "Slept in the pram",
	})
	if patched.Status != http.StatusOK || patched.JSON["pickupCaretakerId"] != w.memberID || patched.JSON["caretakerId"] != w.memberID || patched.JSON["notes"] != "Slept in the pram" {
		t.Fatalf("patch = %d %v", patched.Status, patched.JSON)
	}
	if patched.JSON["loggedById"] != w.adminID {
		t.Errorf("loggedById = %v, want unchanged by a patch", patched.JSON["loggedById"])
	}

	cleared := a.Do(http.MethodPatch, "/api/daycare/"+id, w.cookie, map[string]any{"pickupCaretakerId": nil})
	if cleared.Status != http.StatusOK || cleared.JSON["pickupCaretakerId"] != nil || cleared.JSON["pickupCaretakerName"] != nil {
		t.Errorf("clearing the pick-up person = %d %v", cleared.Status, cleared.JSON)
	}

	// Reopen: she is back at barnehage, and nobody has picked her up.
	a.Do(http.MethodPatch, "/api/daycare/"+id, w.cookie, map[string]any{"pickupCaretakerId": w.memberID})
	reopened := a.Do(http.MethodPatch, "/api/daycare/"+id, w.cookie, map[string]any{"endTime": nil})
	if reopened.Status != http.StatusOK || reopened.JSON["endTime"] != nil || reopened.JSON["pickupCaretakerId"] != nil {
		t.Errorf("reopen = %d %v, want endTime and pickupCaretakerId null", reopened.Status, reopened.JSON)
	}

	// A second finished day cannot be reopened beside it.
	other := a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{
		"babyId": w.babyID, "startTime": rfc(end.Add(-30 * time.Hour)), "endTime": rfc(end.Add(-24 * time.Hour)),
	})
	otherID, _ := other.JSON["id"].(string)
	clash := a.Do(http.MethodPatch, "/api/daycare/"+otherID, w.cookie, map[string]any{"endTime": nil})
	if clash.Status != http.StatusConflict || clash.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("reopen beside a running session = %d %v, want 409 ALREADY_ACTIVE", clash.Status, clash.JSON)
	}
}

// Tenancy: another family's day is invisible to every operation.
func TestDaycareIsFamilyScoped(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Hansen", "a@example.com")
	babyA := a.NewBaby(familyA, "Nora")
	_, cookieB := a.NewFamily("Olsen", "b@example.com")

	drop := a.Do(http.MethodPost, "/api/daycare", cookieA, map[string]any{"babyId": babyA, "startTime": rfc(time.Now())})
	id, _ := drop.JSON["id"].(string)

	if res := a.Do(http.MethodPost, "/api/daycare", cookieB, map[string]any{"babyId": babyA, "startTime": rfc(time.Now())}); res.Status != http.StatusNotFound {
		t.Errorf("drop-off of another family's baby = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodPost, "/api/daycare/"+id+"/pickup", cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("pickup across families = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodPatch, "/api/daycare/"+id, cookieB, map[string]any{"notes": "mine now"}); res.Status != http.StatusNotFound {
		t.Errorf("patch across families = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/daycare/"+id, cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("delete across families = %d, want 404", res.Status)
	}
	if list := a.DoArray(http.MethodGet, "/api/daycare", cookieB, nil); len(list.JSON) != 0 {
		t.Errorf("other family lists %d rows, want 0", len(list.JSON))
	}
	if active := a.Do(http.MethodGet, "/api/daycare/active?babyId="+babyA, cookieB, nil); string(active.Raw) != "null" {
		t.Errorf("other family sees an active session: %s", active.Raw)
	}
	if still := a.Do(http.MethodGet, "/api/daycare/active?babyId="+babyA, cookieA, nil); still.JSON["id"] != id {
		t.Errorf("the owner's session did not survive: %s", still.Raw)
	}
	if res := a.Do(http.MethodDelete, "/api/daycare/"+id, cookieA, nil); res.Status != http.StatusOK {
		t.Errorf("owner delete = %d, want 200", res.Status)
	}
}

// A kiosk is a nursery tablet at home: deviceOperations leaves daycare out.
func TestDaycareIsNotForDevices(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	device := w.a.CreateDevice(w.familyID, w.adminID)
	req, _ := http.NewRequest(http.MethodGet, "/api/daycare/active?babyId="+w.babyID, nil)
	req.Header.Set("Cookie", device)
	req.Header.Set("X-Pjokk-Caretaker", w.adminID)
	if res := w.a.DoRequest(req); res.Status != http.StatusForbidden || res.JSON["code"] != "NOT_FOR_DEVICES" {
		t.Errorf("device GET /api/daycare/active = %d %v, want 403 NOT_FOR_DEVICES", res.Status, res.JSON)
	}
}

func TestDaycareOnTheTimelineAndInTheExport(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	end := time.Now().Add(-time.Hour).Truncate(time.Second)
	start := end.Add(-7*time.Hour - 30*time.Minute)
	a.Do(http.MethodPost, "/api/daycare", w.cookie, map[string]any{
		"babyId": w.babyID, "startTime": rfc(start), "endTime": rfc(end),
		"pickupCaretakerId": w.memberID, "notes": "Trip to the forest",
	})
	a.Do(http.MethodPost, "/api/diapers", w.cookie, map[string]any{"babyId": w.babyID, "time": rfc(end.Add(30 * time.Minute)), "type": "wet"})

	for _, query := range []string{"", "&filter=other", "&q=forest"} {
		tl := a.Do(http.MethodGet, "/api/timeline?babyId="+w.babyID+query, w.cookie, nil)
		entries, _ := tl.JSON["entries"].([]any)
		var day map[string]any
		for _, e := range entries {
			if m := e.(map[string]any); m["kind"] == "daycare" {
				day = m
			}
		}
		if day == nil {
			t.Fatalf("timeline%s has no daycare entry: %s", query, tl.Raw)
		}
		if day["pickupCaretakerName"] != "Bo Hansen" || day["endTime"] == nil || day["startTime"] == nil {
			t.Errorf("timeline%s daycare entry = %v", query, day)
		}
	}
	// Sorted by its start: the later diaper comes first.
	tl := a.Do(http.MethodGet, "/api/timeline?babyId="+w.babyID, w.cookie, nil)
	if entries, _ := tl.JSON["entries"].([]any); len(entries) != 2 || entries[0].(map[string]any)["kind"] != "diaper" {
		t.Errorf("timeline order = %s, want the diaper before the day", tl.Raw)
	}
	for _, filter := range []string{"feeds", "sleep", "diapers"} {
		tl := a.Do(http.MethodGet, "/api/timeline?babyId="+w.babyID+"&filter="+filter, w.cookie, nil)
		if strings.Contains(string(tl.Raw), `"daycare"`) {
			t.Errorf("filter=%s carries the daycare entry", filter)
		}
	}

	csv := a.Do(http.MethodGet, "/api/export.csv", w.cookie, nil)
	var line string
	for _, l := range strings.Split(string(csv.Raw), "\n") {
		if strings.HasPrefix(l, "daycare,") {
			line = l
		}
	}
	if line == "" {
		t.Fatalf("export has no daycare row:\n%s", csv.Raw)
	}
	for _, want := range []string{"Nora", "picked up by Bo Hansen", ",450,", "Trip to the forest"} {
		if !strings.Contains(line, want) {
			t.Errorf("export row %q lacks %q", line, want)
		}
	}
}

// Deleting an account must not trip over any of the three people on a row.
func TestDaycareSurvivesTheDeletionOfEveryoneOnIt(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	end := time.Now().Add(-time.Hour)
	// Dropped off and logged by the partner; picked up by them too.
	day := a.Do(http.MethodPost, "/api/daycare", w.partner, map[string]any{
		"babyId": w.babyID, "startTime": rfc(end.Add(-7 * time.Hour)), "endTime": rfc(end), "pickupCaretakerId": w.memberID,
	})
	if day.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", day.Status, day.Raw)
	}
	makeSysadmin(t, a, w.adminID)
	del := a.Do(http.MethodPost, "/api/admin/users/"+w.memberID+"/delete", w.cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("delete user status = %d, body %s", del.Status, del.Raw)
	}
	list := a.DoArray(http.MethodGet, "/api/daycare?babyId="+w.babyID, w.cookie, nil)
	if len(list.JSON) != 1 {
		t.Fatalf("rows after the deletion = %d, want 1", len(list.JSON))
	}
	row := list.JSON[0].(map[string]any)
	if row["caretakerId"] == w.memberID || row["loggedById"] == w.memberID || row["pickupCaretakerId"] == w.memberID {
		t.Errorf("row still names the deleted user: %v", row)
	}
	if row["caretakerId"] != row["pickupCaretakerId"] || row["pickupCaretakerId"] == nil {
		t.Errorf("row = %v, want all three people on the tombstone", row)
	}
}
