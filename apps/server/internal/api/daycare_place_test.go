package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// -----------------------------------------------------------------------
// The barnehage as a place and the pick-up plan
// (internal/api/daycare_place.go, spec
// docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
// No TypeScript ancestor: the feature postdates the Go migration.
// -----------------------------------------------------------------------

func placeBody(w twoParents, extra map[string]any) map[string]any {
	body := map[string]any{
		"name":         "Solsikken barnehage",
		"address":      "Storgata 1, 0155 Oslo",
		"phone":        "+47 22 00 00 00",
		"openMinute":   7*60 + 30,
		"closeMinute":  16*60 + 30,
		"alertLeadMin": 30,
		"tz":           "Europe/Oslo",
		"babyIds":      []string{w.babyID},
	}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func TestDaycarePlaceIsWrittenByParentsAndReadByEveryone(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a

	if res := a.Do(http.MethodPost, "/api/daycare-places", w.partner, placeBody(w, nil)); res.Status != http.StatusForbidden {
		t.Fatalf("a member creating a place = %d %s, want 403", res.Status, res.Raw)
	}
	created := a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, map[string]any{"email": "  "}))
	if created.Status != http.StatusCreated {
		t.Fatalf("POST = %d %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)
	if created.JSON["closeMinute"] != float64(990) || created.JSON["tz"] != "Europe/Oslo" {
		t.Errorf("created = %s, want the hours and the zone back", created.Raw)
	}
	if created.JSON["email"] != nil {
		t.Errorf("a blank email = %v, want null (not recorded)", created.JSON["email"])
	}
	if babies, _ := created.JSON["babyIds"].([]any); len(babies) != 1 || babies[0] != w.babyID {
		t.Errorf("babyIds = %v, want the enrolled baby", created.JSON["babyIds"])
	}

	// The member reads it: a grandparent needs the phone number.
	list := a.DoArray(http.MethodGet, "/api/daycare-places", w.partner, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("a member's list = %d %s, want the one place", list.Status, list.Raw)
	}

	// A PUT replaces the row and its enrolments whole.
	updated := a.Do(http.MethodPut, "/api/daycare-places/"+id, w.cookie, map[string]any{"name": "Solsikken", "tz": "Europe/Oslo"})
	if updated.Status != http.StatusOK {
		t.Fatalf("PUT = %d %s", updated.Status, updated.Raw)
	}
	if updated.JSON["name"] != "Solsikken" || updated.JSON["phone"] != nil || updated.JSON["closeMinute"] != nil {
		t.Errorf("after a bare PUT = %s, want every omitted field cleared", updated.Raw)
	}
	if babies, _ := updated.JSON["babyIds"].([]any); len(babies) != 0 {
		t.Errorf("babyIds after a PUT without any = %v, want none", babies)
	}
	if res := a.Do(http.MethodPut, "/api/daycare-places/"+id, w.partner, placeBody(w, nil)); res.Status != http.StatusForbidden {
		t.Errorf("a member's PUT = %d, want 403", res.Status)
	}

	if res := a.Do(http.MethodDelete, "/api/daycare-places/"+id, w.partner, nil); res.Status != http.StatusForbidden {
		t.Errorf("a member's DELETE = %d, want 403", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/daycare-places/"+id, w.cookie, nil); res.Status != http.StatusOK {
		t.Errorf("DELETE = %d %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodDelete, "/api/daycare-places/"+id, w.cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("a second DELETE = %d, want 404", res.Status)
	}
}

func TestDaycarePlaceRefusesAZoneThatDoesNotLoadAndAStrangersBaby(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	if res := a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, map[string]any{"tz": "Oslo/Nowhere"})); res.Status != http.StatusBadRequest || res.JSON["code"] != "BAD_TZ" {
		t.Errorf("an unknown zone = %d %v, want 400 BAD_TZ", res.Status, res.JSON)
	}

	otherFamily, other := a.NewFamily("Berg", "berit@example.com")
	theirBaby := a.NewBaby(otherFamily, "Ola")
	if res := a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, map[string]any{"babyIds": []string{theirBaby}})); res.Status != http.StatusBadRequest || res.JSON["code"] != "INVALID_REFERENCE" {
		t.Errorf("another family's baby = %d %v, want 400 INVALID_REFERENCE", res.Status, res.JSON)
	}

	// Tenancy: the other family neither sees nor touches ours.
	created := a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, nil))
	id, _ := created.JSON["id"].(string)
	if list := a.DoArray(http.MethodGet, "/api/daycare-places", other, nil); len(list.JSON) != 0 {
		t.Errorf("the other family lists %s", list.Raw)
	}
	if res := a.Do(http.MethodPut, "/api/daycare-places/"+id, other, map[string]any{"name": "Theirs", "tz": "Europe/Oslo"}); res.Status != http.StatusNotFound {
		t.Errorf("the other family's PUT = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/daycare-places/"+id, other, nil); res.Status != http.StatusNotFound {
		t.Errorf("the other family's DELETE = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodGet, "/api/babies/"+w.babyID+"/pickup-plan", other, nil); res.Status != http.StatusNotFound {
		t.Errorf("the other family reading our plan = %d, want 404", res.Status)
	}
}

// A baby attends one place: naming her on a second place moves her.
func TestEnrollingABabyMovesHerFromTheOtherPlace(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	first := a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, nil))
	second := a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, map[string]any{"name": "Blåbærtoppen"}))
	if second.Status != http.StatusCreated {
		t.Fatalf("second place = %d %s", second.Status, second.Raw)
	}
	list := a.DoArray(http.MethodGet, "/api/daycare-places", w.cookie, nil)
	for _, p := range list.JSON {
		m := p.(map[string]any)
		babies, _ := m["babyIds"].([]any)
		switch m["id"] {
		case first.JSON["id"]:
			if len(babies) != 0 {
				t.Errorf("the first place still has %v", babies)
			}
		case second.JSON["id"]:
			if len(babies) != 1 {
				t.Errorf("the second place has %v, want her", babies)
			}
		}
	}
}

func TestPickupPlanIsReplacedWholeByAParent(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	path := "/api/babies/" + w.babyID + "/pickup-plan"

	plan := map[string]any{"days": []map[string]any{
		{"weekday": 1, "minute": 15*60 + 30, "userId": w.adminID},
		{"weekday": 2, "minute": 15*60 + 30, "userId": w.memberID},
		{"weekday": 3, "minute": nil, "userId": nil}, // unplanned: dropped
		{"weekday": 5, "minute": 14 * 60, "userId": nil},
	}}
	if res := a.Do(http.MethodPut, path, w.partner, plan); res.Status != http.StatusForbidden {
		t.Fatalf("a member's PUT = %d, want 403", res.Status)
	}
	saved := a.Do(http.MethodPut, path, w.cookie, plan)
	if saved.Status != http.StatusOK {
		t.Fatalf("PUT = %d %s", saved.Status, saved.Raw)
	}
	days, _ := saved.JSON["days"].([]any)
	if len(days) != 3 {
		t.Fatalf("days = %v, want Monday, Tuesday and Friday", days)
	}
	if fri := days[2].(map[string]any); fri["weekday"] != float64(5) || fri["minute"] != float64(840) || fri["userId"] != nil {
		t.Errorf("Friday = %v, want 14:00 and nobody named", fri)
	}

	// Replaced whole, and idempotent: the same body twice reads the same.
	again := a.Do(http.MethodPut, path, w.cookie, map[string]any{"days": []map[string]any{{"weekday": 4, "minute": 900, "userId": w.memberID}}})
	if d, _ := again.JSON["days"].([]any); len(d) != 1 || d[0].(map[string]any)["weekday"] != float64(4) {
		t.Errorf("after the second PUT = %s, want Thursday alone", again.Raw)
	}
	read := a.Do(http.MethodGet, path, w.partner, nil)
	if d, _ := read.JSON["days"].([]any); read.Status != http.StatusOK || len(d) != 1 {
		t.Errorf("a member's GET = %d %s", read.Status, read.Raw)
	}

	if res := a.Do(http.MethodPut, path, w.cookie, map[string]any{"days": []map[string]any{{"weekday": 1, "minute": 900, "userId": nil}, {"weekday": 1, "minute": 930, "userId": nil}}}); res.Status != http.StatusBadRequest || res.JSON["code"] != "DUPLICATE_DAY" {
		t.Errorf("Monday twice = %d %v, want 400 DUPLICATE_DAY", res.Status, res.JSON)
	}
	stranger := a.SignUp("Siv Berg", "siv@example.com")
	if res := a.Do(http.MethodPut, path, w.cookie, map[string]any{"days": []map[string]any{{"weekday": 1, "minute": 900, "userId": stranger}}}); res.Status != http.StatusBadRequest || res.JSON["code"] != "INVALID_REFERENCE" {
		t.Errorf("a non-member in the grid = %d %v, want 400 INVALID_REFERENCE", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPut, path, w.cookie, map[string]any{"days": []map[string]any{{"weekday": 6, "minute": 900, "userId": nil}}}); res.Status != http.StatusBadRequest {
		t.Errorf("a Saturday = %d, want 400 from the spec", res.Status)
	}
}

func TestPickupOverrideIsAnyMembersAndClears(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	path := "/api/babies/" + w.babyID + "/pickup-override"
	today := time.Now().UTC().Format("2006-01-02")

	set := a.Do(http.MethodPut, path, w.partner, map[string]any{"date": today, "userId": w.memberID})
	if set.Status != http.StatusOK {
		t.Fatalf("a member's override = %d %s", set.Status, set.Raw)
	}
	if o, _ := set.JSON["overrides"].([]any); len(o) != 1 || o[0].(map[string]any)["userId"] != w.memberID || o[0].(map[string]any)["date"] != today {
		t.Errorf("overrides = %v, want today for the member", set.JSON["overrides"])
	}
	// One per baby per day: a second PUT replaces.
	a.Do(http.MethodPut, path, w.cookie, map[string]any{"date": today, "userId": w.adminID})
	read := a.Do(http.MethodGet, "/api/babies/"+w.babyID+"/pickup-plan", w.cookie, nil)
	if o, _ := read.JSON["overrides"].([]any); len(o) != 1 || o[0].(map[string]any)["userId"] != w.adminID {
		t.Errorf("after the second PUT = %v, want the admin alone", read.JSON["overrides"])
	}
	// Long past exceptions are not served.
	a.Do(http.MethodPut, path, w.cookie, map[string]any{"date": "2026-01-05", "userId": w.adminID})
	read = a.Do(http.MethodGet, "/api/babies/"+w.babyID+"/pickup-plan", w.cookie, nil)
	if o, _ := read.JSON["overrides"].([]any); len(o) != 1 {
		t.Errorf("overrides = %v, want January's left out", o)
	}

	cleared := a.Do(http.MethodPut, path, w.partner, map[string]any{"date": today, "userId": nil})
	if o, _ := cleared.JSON["overrides"].([]any); cleared.Status != http.StatusOK || len(o) != 0 {
		t.Errorf("after clearing = %d %s", cleared.Status, cleared.Raw)
	}

	if res := a.Do(http.MethodPut, path, w.cookie, map[string]any{"date": "2026-02-30", "userId": w.adminID}); res.Status != http.StatusBadRequest || res.JSON["code"] != "BAD_DATE" {
		t.Errorf("30 February = %d %v, want 400 BAD_DATE", res.Status, res.JSON)
	}
	stranger := a.SignUp("Siv Berg", "siv@example.com")
	if res := a.Do(http.MethodPut, path, w.cookie, map[string]any{"date": today, "userId": stranger}); res.Status != http.StatusBadRequest || res.JSON["code"] != "INVALID_REFERENCE" {
		t.Errorf("a non-member = %d %v, want 400 INVALID_REFERENCE", res.Status, res.JSON)
	}
}

func TestSummaryCarriesThePlaceAndThePlan(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	summary := a.Do(http.MethodGet, "/api/summary?babyId="+w.babyID, w.cookie, nil)
	if v, present := summary.JSON["daycare"]; !present || v != nil {
		t.Fatalf("summary.daycare with nothing set = %v (present %v), want an explicit null", v, present)
	}

	a.Do(http.MethodPost, "/api/daycare-places", w.cookie, placeBody(w, nil))
	a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/pickup-plan", w.cookie, map[string]any{"days": []map[string]any{{"weekday": 1, "minute": 930, "userId": w.memberID}}})

	summary = a.Do(http.MethodGet, "/api/summary?babyId="+w.babyID, w.partner, nil)
	day, _ := summary.JSON["daycare"].(map[string]any)
	if day == nil {
		t.Fatalf("summary.daycare = %s", summary.Raw)
	}
	if place, _ := day["place"].(map[string]any); place == nil || place["name"] != "Solsikken barnehage" || place["closeMinute"] != float64(990) {
		t.Errorf("summary.daycare.place = %v", day["place"])
	}
	plan, _ := day["plan"].(map[string]any)
	if days, _ := plan["days"].([]any); len(days) != 1 {
		t.Errorf("summary.daycare.plan = %v, want Monday", plan)
	}
}

// A removed member is no longer anyone's planned pick-up: the day keeps
// its time and loses the person, and their one-day exceptions go.
func TestRemovedMemberLeavesThePickupPlan(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/pickup-plan", w.cookie, map[string]any{"days": []map[string]any{{"weekday": 2, "minute": 930, "userId": w.memberID}}})
	a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/pickup-override", w.cookie, map[string]any{"date": time.Now().UTC().Format("2006-01-02"), "userId": w.memberID})

	members := a.DoArray(http.MethodGet, "/api/family/members", w.cookie, nil)
	var membershipID string
	for _, m := range members.JSON {
		if mm := m.(map[string]any); mm["userId"] == w.memberID {
			membershipID, _ = mm["memberId"].(string)
		}
	}
	if res := a.Do(http.MethodDelete, "/api/family/members/"+membershipID, w.cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("remove member = %d %s", res.Status, res.Raw)
	}

	read := a.Do(http.MethodGet, "/api/babies/"+w.babyID+"/pickup-plan", w.cookie, nil)
	days, _ := read.JSON["days"].([]any)
	if len(days) != 1 || days[0].(map[string]any)["userId"] != nil || days[0].(map[string]any)["minute"] != float64(930) {
		t.Errorf("days after the removal = %v, want Tuesday 15:30 with nobody named", days)
	}
	if o, _ := read.JSON["overrides"].([]any); len(o) != 0 {
		t.Errorf("overrides after the removal = %v, want none", o)
	}
	var left int
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT COUNT(*)::int FROM "daycare_pickup_override" WHERE "user_id" = $1`, w.memberID).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Errorf("%d override rows left behind", left)
	}
}
