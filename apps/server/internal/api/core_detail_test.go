package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Detail fields on the three core logs (issue #43): bottle contents, solids
// food + reaction, a dry diaper with colour/consistency, nap-vs-night.
// Every field is optional and nullable — the two-tap happy path never has
// to send any of them — and every one follows feeds.go's PATCH tri-state
// (omitted = leave, null = clear, value = set).
// -----------------------------------------------------------------------

func TestFeedContentsRoundTripAndClear(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 120,
		"contents": "formula",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["contents"] != "formula" {
		t.Errorf("contents = %v, want formula", created.JSON["contents"])
	}
	// The solids-only fields are present-and-null on a bottle, never absent.
	for _, k := range []string{"food", "reaction"} {
		if v, ok := created.JSON[k]; !ok || v != nil {
			t.Errorf("%s = %v (present %v), want present and null", k, v, ok)
		}
	}
	id, _ := created.JSON["id"].(string)

	set := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"contents": "mixed"})
	if set.Status != http.StatusOK || set.JSON["contents"] != "mixed" {
		t.Fatalf("PATCH set: status %d contents %v, body %s", set.Status, set.JSON["contents"], set.Raw)
	}
	untouched := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"notes": "warm"})
	if untouched.JSON["contents"] != "mixed" {
		t.Errorf("contents after unrelated PATCH = %v, want still mixed", untouched.JSON["contents"])
	}
	cleared := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"contents": nil})
	if cleared.Status != http.StatusOK || cleared.JSON["contents"] != nil {
		t.Errorf("PATCH clear: status %d contents %v, want 200 and null", cleared.Status, cleared.JSON["contents"])
	}
}

func TestFeedSolidsFoodAndReaction(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "solids",
		"amountMl": 40,
		"food":     "Banana",
		"reaction": true,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["food"] != "Banana" || created.JSON["reaction"] != true {
		t.Errorf("food/reaction = %v/%v, want Banana/true", created.JSON["food"], created.JSON["reaction"])
	}
	id, _ := created.JSON["id"].(string)

	// Switching type to bottle from the sheet clears the solids fields with
	// explicit nulls, exactly as amountMl is cleared when switching to breast.
	switched := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{
		"type": "bottle", "food": nil, "reaction": nil, "contents": "breast_milk",
	})
	if switched.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", switched.Status, switched.Raw)
	}
	if switched.JSON["food"] != nil || switched.JSON["reaction"] != nil || switched.JSON["contents"] != "breast_milk" {
		t.Errorf("after switch: food %v reaction %v contents %v", switched.JSON["food"], switched.JSON["reaction"], switched.JSON["contents"])
	}
}

func TestFeedContentsRejectsUnknownValue(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"contents": "juice",
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 from spec validation, body %s", res.Status, res.Raw)
	}
}

func TestDiaperDryTypeAndDetail(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	dry := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "dry",
	})
	if dry.Status != http.StatusCreated || dry.JSON["type"] != "dry" {
		t.Fatalf("dry POST: status %d type %v, body %s", dry.Status, dry.JSON["type"], dry.Raw)
	}
	for _, k := range []string{"color", "consistency"} {
		if v, ok := dry.JSON[k]; !ok || v != nil {
			t.Errorf("%s = %v (present %v), want present and null", k, v, ok)
		}
	}

	dirty := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId":      babyID,
		"time":        time.Now().UTC().Format(time.RFC3339),
		"type":        "dirty",
		"color":       "green",
		"consistency": "loose",
	})
	if dirty.Status != http.StatusCreated {
		t.Fatalf("dirty POST status = %d, body %s", dirty.Status, dirty.Raw)
	}
	if dirty.JSON["color"] != "green" || dirty.JSON["consistency"] != "loose" {
		t.Errorf("color/consistency = %v/%v, want green/loose", dirty.JSON["color"], dirty.JSON["consistency"])
	}
	id, _ := dirty.JSON["id"].(string)

	cleared := a.Do(http.MethodPatch, "/api/diapers/"+id, cookie, map[string]any{"color": nil})
	if cleared.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", cleared.Status, cleared.Raw)
	}
	if cleared.JSON["color"] != nil {
		t.Errorf("color after explicit-null PATCH = %v, want null", cleared.JSON["color"])
	}
	if cleared.JSON["consistency"] != "loose" {
		t.Errorf("consistency after unrelated clear = %v, want still loose", cleared.JSON["consistency"])
	}

	bad := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "dirty",
		"color":  "purple",
	})
	if bad.Status != http.StatusBadRequest {
		t.Errorf("unknown colour status = %d, want 400, body %s", bad.Status, bad.Raw)
	}
}

func TestSleepKindRoundTripAndClear(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// No type sent: the column is present and null, never defaulted by the
	// server (it cannot know the family's night schedule).
	plain := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339),
		"endTime":   time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
	})
	if plain.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", plain.Status, plain.Raw)
	}
	if v, ok := plain.JSON["type"]; !ok || v != nil {
		t.Errorf("type = %v (present %v), want present and null", v, ok)
	}

	night := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": time.Now().UTC().Format(time.RFC3339),
		"type":      "night",
	})
	if night.Status != http.StatusCreated || night.JSON["type"] != "night" {
		t.Fatalf("night POST: status %d type %v, body %s", night.Status, night.JSON["type"], night.Raw)
	}
	id, _ := night.JSON["id"].(string)

	active := a.Do(http.MethodGet, "/api/sleep/active?babyId="+babyID, cookie, nil)
	if active.JSON["type"] != "night" {
		t.Errorf("active session type = %v, want night", active.JSON["type"])
	}

	nap := a.Do(http.MethodPatch, "/api/sleep/"+id, cookie, map[string]any{"type": "nap"})
	if nap.Status != http.StatusOK || nap.JSON["type"] != "nap" {
		t.Fatalf("PATCH set: status %d type %v, body %s", nap.Status, nap.JSON["type"], nap.Raw)
	}
	cleared := a.Do(http.MethodPatch, "/api/sleep/"+id, cookie, map[string]any{"type": nil})
	if cleared.Status != http.StatusOK || cleared.JSON["type"] != nil {
		t.Errorf("PATCH clear: status %d type %v, want 200 and null", cleared.Status, cleared.JSON["type"])
	}
}

func TestSummaryTodayCountsDryDiapers(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	a.SetNow(now)
	for _, typ := range []string{"wet", "dry", "dry"} {
		a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
			"babyId": babyID, "time": now.Format(time.RFC3339), "type": typ,
		})
	}

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	today := res.JSON["today"].(map[string]any)
	if today["wet"] != float64(1) || today["dry"] != float64(2) || today["both"] != float64(0) {
		t.Errorf("today = %v, want wet 1, dry 2, both 0 (a dry check must not inflate wet)", today)
	}
}

func TestTimelineCarriesDetailFields(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "solids", "amountMl": 30, "food": "Pear", "reaction": false,
	})
	a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID, "time": now.Add(time.Minute).Format(time.RFC3339), "type": "both", "color": "yellow", "consistency": "normal",
	})
	a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId": babyID, "startTime": now.Add(2 * time.Minute).Format(time.RFC3339), "endTime": now.Add(30 * time.Minute).Format(time.RFC3339), "type": "nap",
	})

	res := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	entries, _ := res.JSON["entries"].([]any)
	got := map[string]map[string]any{}
	for _, e := range entries {
		m := e.(map[string]any)
		got[m["kind"].(string)] = m
	}
	if got["feed"]["food"] != "Pear" || got["feed"]["reaction"] != false || got["feed"]["contents"] != nil {
		t.Errorf("feed entry = %v, want food Pear, reaction false, contents null", got["feed"])
	}
	if got["diaper"]["color"] != "yellow" || got["diaper"]["consistency"] != "normal" {
		t.Errorf("diaper entry = %v, want color yellow, consistency normal", got["diaper"])
	}
	if got["sleep"]["type"] != "nap" {
		t.Errorf("sleep entry = %v, want type nap", got["sleep"])
	}
}

// The CSV keeps its header (export.ts's HEADERS, verbatim); the new detail
// lands in the existing free `detail` column so downstream spreadsheets keep
// their column positions.
func TestExportCSVDetailColumnCarriesCoreLogDetail(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "bottle", "amountMl": 90, "contents": "formula",
	})
	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Add(time.Minute).Format(time.RFC3339), "type": "solids", "amountMl": 30, "food": "Pear", "reaction": true,
	})
	a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID, "time": now.Add(2 * time.Minute).Format(time.RFC3339), "type": "dirty", "color": "green", "consistency": "loose",
	})
	a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId": babyID, "startTime": now.Add(3 * time.Minute).Format(time.RFC3339), "endTime": now.Add(30 * time.Minute).Format(time.RFC3339), "type": "night",
	})

	res := a.Do(http.MethodGet, "/api/export.csv", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	csv := string(res.Raw)
	for _, want := range []string{
		"feed,Nora,", ",bottle,formula,90,ml,",
		",solids,Pear · reaction,30,g,",
		"diaper,Nora,", ",dirty,green · loose,",
		"sleep,Nora,", ",,night,",
	} {
		if !strings.Contains(csv, want) {
			t.Errorf("csv missing %q:\n%s", want, csv)
		}
	}
}
