package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// -----------------------------------------------------------------------
// Days at home with an ill child (issue #108, internal/api/care_days.go).
// -----------------------------------------------------------------------

func careTotals(t *testing.T, w twoParents, year string) map[string]map[string]any {
	t.Helper()
	res := w.a.Do(http.MethodGet, "/api/care-days?year="+year, w.cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("GET care-days: %d %s", res.Status, res.Raw)
	}
	out := map[string]map[string]any{}
	for _, row := range res.JSON["totals"].([]any) {
		m := row.(map[string]any)
		out[m["userId"].(string)] = m
	}
	return out
}

func TestCareDaysCountPerPersonPerYear(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	for _, body := range []map[string]any{
		{"date": "2026-03-16"},                                     // the caller, whole
		{"date": "2026-03-17", "fraction": 0.5},                    // the caller, half
		{"date": "2026-03-17", "userId": w.memberID},               // the partner, the same date
		{"date": "2025-12-30", "userId": w.memberID, "note": "RS"}, // last year's
	} {
		if res := a.Do(http.MethodPost, "/api/care-days", w.cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("POST %v = %d %s", body, res.Status, res.Raw)
		}
	}

	totals := careTotals(t, w, "2026")
	if got := totals[w.adminID]["used"]; got != 1.5 {
		t.Errorf("caller used in 2026 = %v, want 1.5", got)
	}
	if got := totals[w.memberID]["used"]; got != float64(1) {
		t.Errorf("partner used in 2026 = %v, want 1", got)
	}
	if got := careTotals(t, w, "2025")[w.memberID]["used"]; got != float64(1) {
		t.Errorf("partner used in 2025 = %v, want 1 (30 December)", got)
	}
	// A year with nothing still lists every member, at zero: "0" is an answer.
	if idle := careTotals(t, w, "2024"); len(idle) != 2 || idle[w.adminID]["used"] != float64(0) {
		t.Errorf("2024 totals = %v, want both members at 0", idle)
	}

	list := a.Do(http.MethodGet, "/api/care-days?year=2026", w.cookie, nil)
	days := list.JSON["days"].([]any)
	if len(days) != 3 || days[0].(map[string]any)["date"] != "2026-03-17" || days[2].(map[string]any)["date"] != "2026-03-16" {
		t.Errorf("2026 days = %v, want three, newest first, last year's left out", days)
	}

	// One row per person per date.
	if dup := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-16"}); dup.Status != http.StatusConflict || dup.JSON["code"] != "DUPLICATE" {
		t.Errorf("second row for the same person and date = %d %v, want 409 DUPLICATE", dup.Status, dup.JSON)
	}
}

// No default, no entitlement: a person who has set no number has none.
func TestCareDayQuotaIsEachPersonsOwnNumber(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	if got := careTotals(t, w, "2026")[w.adminID]["quota"]; got != nil {
		t.Errorf("quota before anyone set one = %v, want null", got)
	}

	if res := a.Do(http.MethodPut, "/api/care-days/quota", w.partner, map[string]any{"days": 10}); res.Status != http.StatusOK {
		t.Fatalf("own quota = %d %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPut, "/api/care-days/quota", w.partner, map[string]any{"days": 20, "userId": w.adminID}); res.Status != http.StatusForbidden || res.JSON["code"] != "FORBIDDEN" {
		t.Errorf("a member setting the admin's = %d %v, want 403 FORBIDDEN", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPut, "/api/care-days/quota", w.cookie, map[string]any{"days": 15, "userId": w.memberID}); res.Status != http.StatusOK {
		t.Errorf("an admin setting a member's = %d, want 200", res.Status)
	}
	totals := careTotals(t, w, "2026")
	if totals[w.memberID]["quota"] != float64(15) || totals[w.adminID]["quota"] != nil {
		t.Errorf("quotas = %v / %v, want 15 / null", totals[w.memberID]["quota"], totals[w.adminID]["quota"])
	}
	a.Do(http.MethodPut, "/api/care-days/quota", w.partner, map[string]any{"days": nil})
	if got := careTotals(t, w, "2026")[w.memberID]["quota"]; got != nil {
		t.Errorf("quota after clearing = %v, want null", got)
	}
	stranger := a.SignUp("Stranger", "stranger@example.com")
	if res := a.Do(http.MethodPut, "/api/care-days/quota", w.cookie, map[string]any{"days": 5, "userId": stranger}); res.Status != http.StatusForbidden || res.JSON["code"] != "NOT_MEMBER" {
		t.Errorf("a stranger's quota = %d %v, want 403 NOT_MEMBER", res.Status, res.JSON)
	}
}

func TestCareDayBelongsToAnIllnessOrToNone(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	ill := a.Do(http.MethodPost, "/api/illness", w.cookie, map[string]any{"babyId": w.babyID, "startTime": rfc(time.Now().Add(-24 * time.Hour)), "symptoms": []string{"fever"}})
	illID, _ := ill.JSON["id"].(string)

	linked := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-16", "illnessId": illID})
	if linked.Status != http.StatusCreated || linked.JSON["illnessId"] != illID || linked.JSON["babyId"] != w.babyID {
		t.Fatalf("a day with an illness = %d %v, want the illness and its baby", linked.Status, linked.JSON)
	}
	// The child-minder was ill: no illness, no baby, still a day.
	if bare := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-18"}); bare.Status != http.StatusCreated || bare.JSON["illnessId"] != nil || bare.JSON["babyId"] != nil {
		t.Errorf("a day with no illness = %d %v", bare.Status, bare.JSON)
	}
	// Deleting the illness keeps the day counted.
	a.Do(http.MethodDelete, "/api/illness/"+illID, w.cookie, nil)
	if got := careTotals(t, w, "2026")[w.adminID]["used"]; got != float64(2) {
		t.Errorf("used after deleting the illness = %v, want 2", got)
	}
}

func TestCareDayValidationPatchAndDelete(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	for name, body := range map[string]map[string]any{
		"the 30th of February": {"date": "2026-02-30"},
		"a timestamp":          {"date": "2026-03-16T08:00:00Z"},
		"a third of a day":     {"date": "2026-03-16", "fraction": 0.33},
	} {
		if res := a.Do(http.MethodPost, "/api/care-days", w.cookie, body); res.Status != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, res.Status)
		}
	}
	stranger := a.SignUp("Stranger", "stranger@example.com")
	if res := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-16", "userId": stranger}); res.Status != http.StatusForbidden {
		t.Errorf("a stranger's day = %d, want 403", res.Status)
	}
	if res := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-16", "illnessId": "nope"}); res.Status != http.StatusNotFound {
		t.Errorf("an unknown illness = %d, want 404", res.Status)
	}

	made := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-16"})
	id, _ := made.JSON["id"].(string)
	a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-17"})

	patched := a.Do(http.MethodPatch, "/api/care-days/"+id, w.cookie, map[string]any{"fraction": 0.5, "note": "Home from noon"})
	if patched.Status != http.StatusOK || patched.JSON["fraction"] != 0.5 || patched.JSON["note"] != "Home from noon" || patched.JSON["date"] != "2026-03-16" {
		t.Errorf("PATCH = %d %v", patched.Status, patched.JSON)
	}
	if clash := a.Do(http.MethodPatch, "/api/care-days/"+id, w.cookie, map[string]any{"date": "2026-03-17"}); clash.Status != http.StatusConflict {
		t.Errorf("moving onto the person's other day = %d, want 409", clash.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/care-days/"+id, w.cookie, nil); res.Status != http.StatusOK {
		t.Errorf("delete = %d, want 200", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/care-days/"+id, w.cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", res.Status)
	}
}

func TestCareDaysAreFamilyScopedAndLeaveWithTheirPerson(t *testing.T) {
	t.Parallel()
	w := newTwoParents(t)
	a := w.a
	mine := a.Do(http.MethodPost, "/api/care-days", w.cookie, map[string]any{"date": "2026-03-16"})
	id, _ := mine.JSON["id"].(string)
	a.Do(http.MethodPost, "/api/care-days", w.partner, map[string]any{"date": "2026-03-16"})
	a.Do(http.MethodPut, "/api/care-days/quota", w.partner, map[string]any{"days": 10})

	_, other := a.NewFamily("Olsen", "other@example.com")
	if res := a.Do(http.MethodPatch, "/api/care-days/"+id, other, map[string]any{"fraction": 0.5}); res.Status != http.StatusNotFound {
		t.Errorf("PATCH across families = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/care-days/"+id, other, nil); res.Status != http.StatusNotFound {
		t.Errorf("DELETE across families = %d, want 404", res.Status)
	}
	if list := a.Do(http.MethodGet, "/api/care-days?year=2026", other, nil); len(list.JSON["days"].([]any)) != 0 {
		t.Errorf("the other family sees %s", list.Raw)
	}

	// The CSV carries them.
	csv := a.Do(http.MethodGet, "/api/export.csv", w.cookie, nil)
	if !strings.Contains(string(csv.Raw), "care_day,,2026-03-16,,,full day,") {
		t.Errorf("export lacks the care days:\n%s", csv.Raw)
	}

	// Removing the partner from the family takes their days and their
	// number with them; the admin's stay.
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
	var days, quotas int
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT (SELECT COUNT(*)::int FROM "care_day" WHERE "user_id" = $1), (SELECT COUNT(*)::int FROM "care_day_quota" WHERE "user_id" = $1)`, w.memberID).Scan(&days, &quotas); err != nil {
		t.Fatal(err)
	}
	if days != 0 || quotas != 0 {
		t.Errorf("the removed member left %d days and %d quotas behind", days, quotas)
	}
	if got := careTotals(t, w, "2026"); len(got) != 1 || got[w.adminID]["used"] != float64(1) {
		t.Errorf("totals after the removal = %v, want the admin alone with 1", got)
	}
}
