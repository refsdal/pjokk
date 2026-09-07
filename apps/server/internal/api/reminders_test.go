package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Reminders (issue #45): a small per-user list replacing push_pref's single
// feed-gap integer. The due logic is internal/jobs' business (see
// jobs/reminders_test.go); these tests cover the personal CRUD and the
// shape validation the spec's enums cannot express on their own.
// -----------------------------------------------------------------------

func createReminder(t *testing.T, a *testrig.AppRig, cookie string, body map[string]any) map[string]any {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/reminders", cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("POST /api/reminders %v: status %d, body %s", body, res.Status, res.Raw)
	}
	return res.JSON
}

func TestRemindersCreateListDelete(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	if list := a.DoArray(http.MethodGet, "/api/reminders", cookie, nil); list.Status != http.StatusOK || len(list.JSON) != 0 {
		t.Fatalf("initial list = %d %s, want 200 []", list.Status, list.Raw)
	}

	gap := createReminder(t, a, cookie, map[string]any{
		"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "Europe/Oslo",
	})
	if gap["kind"] != "feed" || gap["mode"] != "since_last" || gap["intervalMin"] != float64(180) || gap["babyId"] != nil || gap["days"] != float64(127) || gap["quietStart"] != nil {
		t.Errorf("gap reminder = %v, want feed/since_last/180, any baby, every day, no quiet hours", gap)
	}
	fixed := createReminder(t, a, cookie, map[string]any{
		"kind": "custom", "mode": "at_time", "atMinute": 9 * 60, "days": 31, "tz": "Europe/Oslo",
		"label": "Vitamin D", "babyId": babyID, "quietStart": 22, "quietEnd": 7,
	})
	if fixed["atMinute"] != float64(540) || fixed["days"] != float64(31) || fixed["label"] != "Vitamin D" || fixed["babyId"] != babyID || fixed["quietStart"] != float64(22) || fixed["quietEnd"] != float64(7) {
		t.Errorf("fixed reminder = %v", fixed)
	}
	if fixed["lastFiredAt"] != nil {
		t.Errorf("lastFiredAt on a new reminder = %v, want null", fixed["lastFiredAt"])
	}

	list := a.DoArray(http.MethodGet, "/api/reminders", cookie, nil)
	if len(list.JSON) != 2 {
		t.Fatalf("list = %d rows, want 2: %s", len(list.JSON), list.Raw)
	}

	id, _ := gap["id"].(string)
	if del := a.Do(http.MethodDelete, "/api/reminders/"+id, cookie, nil); del.Status != http.StatusOK {
		t.Fatalf("delete = %d %s", del.Status, del.Raw)
	}
	if again := a.Do(http.MethodDelete, "/api/reminders/"+id, cookie, nil); again.Status != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", again.Status)
	}
	if list := a.DoArray(http.MethodGet, "/api/reminders", cookie, nil); len(list.JSON) != 1 {
		t.Errorf("list after delete = %d rows, want 1", len(list.JSON))
	}
}

func TestRemindersValidation(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	a.NewBaby(familyID, "Nora")
	otherFamily, _ := a.NewFamily("Berg", "other@example.com")
	otherBaby := a.NewBaby(otherFamily, "Ola")

	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{"since_last without an interval", map[string]any{"kind": "feed", "mode": "since_last", "tz": "Europe/Oslo"}, http.StatusBadRequest},
		{"at_time without a minute", map[string]any{"kind": "feed", "mode": "at_time", "tz": "Europe/Oslo"}, http.StatusBadRequest},
		{"custom can only be at_time", map[string]any{"kind": "custom", "mode": "since_last", "intervalMin": 60, "tz": "Europe/Oslo", "label": "x"}, http.StatusBadRequest},
		{"custom needs a label", map[string]any{"kind": "custom", "mode": "at_time", "atMinute": 600, "tz": "Europe/Oslo"}, http.StatusBadRequest},
		{"unknown timezone", map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 60, "tz": "Mars/Olympus"}, http.StatusBadRequest},
		{"quiet hours need both ends", map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 60, "tz": "Europe/Oslo", "quietStart": 22}, http.StatusBadRequest},
		{"interval below the spec minimum", map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 5, "tz": "Europe/Oslo"}, http.StatusBadRequest},
		{"another family's baby", map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 60, "tz": "Europe/Oslo", "babyId": otherBaby}, http.StatusNotFound},
	}
	for _, c := range cases {
		res := a.Do(http.MethodPost, "/api/reminders", cookie, c.body)
		if res.Status != c.want {
			t.Errorf("%s: status %d, want %d, body %s", c.name, res.Status, c.want, res.Raw)
		}
	}
}

// A reminder is a personal nag: another member of the same family neither
// sees it nor can delete it.
func TestRemindersArePerUser(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	otherID := a.SignUp("Other parent", "other@example.com")
	otherCookie := a.AddMember(familyID, otherID, auth.RoleMember, "other@example.com")

	mine := createReminder(t, a, cookie, map[string]any{"kind": "diaper", "mode": "since_last", "intervalMin": 120, "tz": "Europe/Oslo"})
	id, _ := mine["id"].(string)

	if list := a.DoArray(http.MethodGet, "/api/reminders", otherCookie, nil); len(list.JSON) != 0 {
		t.Errorf("other member's list = %s, want empty", list.Raw)
	}
	if del := a.Do(http.MethodDelete, "/api/reminders/"+id, otherCookie, nil); del.Status != http.StatusNotFound {
		t.Errorf("other member's delete = %d, want 404", del.Status)
	}
	// API keys are refused by tier — push_test.go's key-auth sweep covers
	// /api/reminders alongside the other tierFamilyNoAPIKey operations.
}
