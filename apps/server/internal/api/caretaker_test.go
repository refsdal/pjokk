package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Who did the care versus who logged it (docs/superpowers/specs/
// 2026-09-14-who-did-it-design.md): caretakerId on a write names the
// person who did the care, loggedById is always the family context's
// user, and a stranger is refused. Diapers stand in for every kind that
// runs on the generic engine; sleep covers the handler that does not; the
// timer covers inheritance on stop.
// -----------------------------------------------------------------------

// twoParents is a family with an admin (signed in as cookie) and a second
// member, plus a baby.
type twoParents struct {
	a        *testrig.AppRig
	familyID string
	babyID   string
	cookie   string
	adminID  string
	memberID string
	partner  string // the member's own Cookie header value
}

func newTwoParents(t *testing.T) twoParents {
	t.Helper()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	memberID := a.SignUp("Bo Hansen", "bo@example.com")
	partner := a.AddMember(familyID, memberID, auth.RoleMember, "bo@example.com")
	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	adminID, _ := me.JSON["userId"].(string)
	if adminID == "" {
		t.Fatalf("GET /api/me = %s, want a userId", me.Raw)
	}
	return twoParents{a: a, familyID: familyID, babyID: babyID, cookie: cookie, adminID: adminID, memberID: memberID, partner: partner}
}

func (w twoParents) diaper(extra map[string]any) *testrig.Result {
	body := map[string]any{
		"babyId": w.babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
	}
	for k, v := range extra {
		body[k] = v
	}
	return w.a.Do(http.MethodPost, "/api/diapers", w.cookie, body)
}

func TestCreateWithoutCaretakerIdRecordsTheCallerTwice(t *testing.T) {
	w := newTwoParents(t)
	res := w.diaper(nil)
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["caretakerId"] != w.adminID || res.JSON["loggedById"] != w.adminID {
		t.Errorf("caretakerId/loggedById = %v/%v, want the caller %q twice", res.JSON["caretakerId"], res.JSON["loggedById"], w.adminID)
	}
	if res.JSON["caretakerName"] != "Rig admin" || res.JSON["loggedByName"] != "Rig admin" {
		t.Errorf("names = %v/%v, want Rig admin twice", res.JSON["caretakerName"], res.JSON["loggedByName"])
	}
}

func TestCreateForAPartnerSplitsCaretakerAndLogger(t *testing.T) {
	w := newTwoParents(t)
	res := w.diaper(map[string]any{"caretakerId": w.memberID})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["caretakerId"] != w.memberID || res.JSON["caretakerName"] != "Bo Hansen" {
		t.Errorf("caretaker = %v/%v, want the partner", res.JSON["caretakerId"], res.JSON["caretakerName"])
	}
	if res.JSON["loggedById"] != w.adminID || res.JSON["loggedByName"] != "Rig admin" {
		t.Errorf("logger = %v/%v, want the caller", res.JSON["loggedById"], res.JSON["loggedByName"])
	}

	// The timeline shows who did it and carries who logged it.
	tl := w.a.Do(http.MethodGet, "/api/timeline?babyId="+w.babyID, w.cookie, nil)
	entries, _ := tl.JSON["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("timeline = %s, want one entry", tl.Raw)
	}
	e, _ := entries[0].(map[string]any)
	if e["caretakerName"] != "Bo Hansen" || e["loggedByName"] != "Rig admin" {
		t.Errorf("timeline entry = %v, want caretaker Bo Hansen, logged by Rig admin", e)
	}

	// And the CSV has both columns.
	csv := w.a.Do(http.MethodGet, "/api/export.csv", w.cookie, nil)
	if csv.Status != http.StatusOK {
		t.Fatalf("export status = %d", csv.Status)
	}
	if want := ",Bo Hansen,Rig admin,"; !strings.Contains(string(csv.Raw), want) {
		t.Errorf("export = %q, want a row containing %q", csv.Raw, want)
	}
}

func TestCreateNamingAStrangerIs403(t *testing.T) {
	w := newTwoParents(t)
	strangerID := w.a.SignUp("Ola Nordmann", "ola@example.com")
	for _, id := range []string{strangerID, "no-such-user", ""} {
		res := w.diaper(map[string]any{"caretakerId": id})
		if res.Status != http.StatusForbidden || res.JSON["code"] != "NOT_MEMBER" {
			t.Errorf("caretakerId %q: status %d body %s, want 403 NOT_MEMBER", id, res.Status, res.Raw)
		}
	}
	list := w.a.DoArray(http.MethodGet, "/api/diapers", w.cookie, nil)
	if len(list.JSON) != 0 {
		t.Errorf("a refused create left %d rows behind", len(list.JSON))
	}
}

func TestUpdateChangesTheCaretakerAndKeepsTheLogger(t *testing.T) {
	w := newTwoParents(t)
	created := w.diaper(nil)
	id, _ := created.JSON["id"].(string)

	res := w.a.Do(http.MethodPatch, "/api/diapers/"+id, w.cookie, map[string]any{"caretakerId": w.memberID})
	if res.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["caretakerId"] != w.memberID || res.JSON["loggedById"] != w.adminID {
		t.Errorf("after PATCH caretaker/logger = %v/%v, want partner/caller", res.JSON["caretakerId"], res.JSON["loggedById"])
	}

	// A stranger is refused and nothing changes; null is not a way to clear.
	stranger := w.a.SignUp("Ola Nordmann", "ola@example.com")
	refused := w.a.Do(http.MethodPatch, "/api/diapers/"+id, w.cookie, map[string]any{"caretakerId": stranger})
	if refused.Status != http.StatusForbidden || refused.JSON["code"] != "NOT_MEMBER" {
		t.Errorf("stranger PATCH = %d %s, want 403 NOT_MEMBER", refused.Status, refused.Raw)
	}
	null := w.a.Do(http.MethodPatch, "/api/diapers/"+id, w.cookie, map[string]any{"caretakerId": nil})
	if null.Status != http.StatusBadRequest {
		t.Errorf("null PATCH = %d %s, want 400", null.Status, null.Raw)
	}
	rows := w.a.DoArray(http.MethodGet, "/api/diapers", w.cookie, nil)
	row, _ := rows.JSON[0].(map[string]any)
	if row["caretakerId"] != w.memberID {
		t.Errorf("after refused PATCHes caretakerId = %v, want still the partner", row["caretakerId"])
	}
}

func TestSleepCreateHonoursCaretakerId(t *testing.T) {
	w := newTwoParents(t)
	res := w.a.Do(http.MethodPost, "/api/sleep", w.cookie, map[string]any{
		"babyId":      w.babyID,
		"startTime":   time.Now().UTC().Format(time.RFC3339),
		"caretakerId": w.memberID,
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["caretakerId"] != w.memberID || res.JSON["loggedById"] != w.adminID {
		t.Errorf("caretaker/logger = %v/%v, want partner/caller", res.JSON["caretakerId"], res.JSON["loggedById"])
	}
	stranger := w.a.SignUp("Ola Nordmann", "ola@example.com")
	refused := w.a.Do(http.MethodPost, "/api/sleep", w.cookie, map[string]any{
		"babyId":      w.babyID,
		"startTime":   time.Now().UTC().Format(time.RFC3339),
		"caretakerId": stranger,
	})
	if refused.Status != http.StatusForbidden {
		t.Errorf("stranger = %d %s, want 403", refused.Status, refused.Raw)
	}
}

func TestTimerStopInheritsTheTimersCaretaker(t *testing.T) {
	w := newTwoParents(t)
	partner := w.partner

	// The admin starts the clock for the partner, who is nursing.
	start := w.a.Do(http.MethodPost, "/api/feeds/timer", w.cookie, map[string]any{
		"babyId": w.babyID, "kind": "breast", "caretakerId": w.memberID,
	})
	if start.Status != http.StatusCreated {
		t.Fatalf("start = %d %s", start.Status, start.Raw)
	}
	if start.JSON["caretakerId"] != w.memberID || start.JSON["loggedById"] != w.adminID {
		t.Errorf("timer caretaker/logger = %v/%v, want partner/admin", start.JSON["caretakerId"], start.JSON["loggedById"])
	}
	id, _ := start.JSON["id"].(string)

	// The partner stops it: the feed is theirs either way, and they logged
	// the stop.
	stop := w.a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", partner, map[string]any{})
	if stop.Status != http.StatusCreated {
		t.Fatalf("stop = %d %s", stop.Status, stop.Raw)
	}
	feed, _ := stop.JSON["feed"].(map[string]any)
	if feed["caretakerId"] != w.memberID || feed["loggedById"] != w.memberID {
		t.Errorf("feed caretaker/logger = %v/%v, want partner/partner", feed["caretakerId"], feed["loggedById"])
	}

	// The other way round: the partner's own timer, stopped by the admin,
	// is still the partner's feed.
	start2 := w.a.Do(http.MethodPost, "/api/feeds/timer", partner, map[string]any{
		"babyId": w.babyID, "kind": "pump",
	})
	id2, _ := start2.JSON["id"].(string)
	stop2 := w.a.Do(http.MethodPost, "/api/feeds/timer/"+id2+"/stop", w.cookie, map[string]any{})
	pump, _ := stop2.JSON["pump"].(map[string]any)
	if pump["caretakerId"] != w.memberID || pump["loggedById"] != w.adminID {
		t.Errorf("pump caretaker/logger = %v/%v, want partner/admin", pump["caretakerId"], pump["loggedById"])
	}
}

func TestDeviceLogHasBothColumnsEqual(t *testing.T) {
	w := newDeviceWorld(t)
	res := w.do(http.MethodPost, "/api/diapers", w.memberID, map[string]any{
		"babyId": w.babyID,
		"time":   time.Now().Format(time.RFC3339),
		"type":   "wet",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("POST as a device = %d %s", res.Status, res.Raw)
	}
	if res.JSON["caretakerId"] != w.memberID || res.JSON["loggedById"] != w.memberID {
		t.Errorf("caretaker/logger = %v/%v, want the chosen caretaker twice", res.JSON["caretakerId"], res.JSON["loggedById"])
	}
}
