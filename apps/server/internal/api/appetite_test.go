package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// How much of a meal she ate (issue #113): an optional detail column on
// feed_log beside food and reaction (core_detail_test.go), what a
// barnehage reports for a lunch nobody weighed.

func TestFeedAppetiteRoundTripClearAndNoAmount(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	now := time.Date(2026, 3, 15, 11, 0, 0, 0, time.UTC)

	// No amount at all: an appetite is enough to say something about a meal.
	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "solids", "food": "Fish cakes", "appetite": "well",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["appetite"] != "well" || created.JSON["amountMl"] != nil {
		t.Errorf("appetite/amountMl = %v/%v, want well/nil", created.JSON["appetite"], created.JSON["amountMl"])
	}
	id, _ := created.JSON["id"].(string)

	// Absent on an ordinary feed: present on the wire, and null.
	plain := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Add(time.Hour).Format(time.RFC3339), "type": "bottle", "amountMl": 120,
	})
	if v, present := plain.JSON["appetite"]; !present || v != nil {
		t.Errorf("bottle appetite = %v (present %v), want an explicit null", v, present)
	}

	changed := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"appetite": "little"})
	if changed.Status != http.StatusOK || changed.JSON["appetite"] != "little" || changed.JSON["food"] != "Fish cakes" {
		t.Errorf("PATCH = %d %v", changed.Status, changed.JSON)
	}
	cleared := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"appetite": nil})
	if cleared.Status != http.StatusOK || cleared.JSON["appetite"] != nil {
		t.Errorf("clearing = %d %v", cleared.Status, cleared.JSON["appetite"])
	}
}

func TestFeedAppetiteRejectsUnknownValue(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "type": "solids", "appetite": "ravenous",
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 from spec validation, body %s", res.Status, res.Raw)
	}
}

func TestAppetiteOnTheTimelineSummaryAndExport(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), "type": "solids", "food": "Porridge", "appetite": "some",
	})

	tl := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID, cookie, nil)
	entries, _ := tl.JSON["entries"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["appetite"] != "some" {
		t.Errorf("timeline = %s, want the feed with appetite some", tl.Raw)
	}
	summary := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if last, _ := summary.JSON["lastFeed"].(map[string]any); last == nil || last["appetite"] != "some" {
		t.Errorf("summary.lastFeed = %v, want appetite some", summary.JSON["lastFeed"])
	}
	csv := a.Do(http.MethodGet, "/api/export.csv", cookie, nil)
	if !strings.Contains(string(csv.Raw), ",solids,Porridge · ate some,") {
		t.Errorf("export lacks the appetite in the detail column:\n%s", csv.Raw)
	}
}
