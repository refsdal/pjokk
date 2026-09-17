package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// What the logs cannot know about a child (issue #109).
func TestBabyAboutRoundTripClearAndTenancy(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	path := "/api/babies/" + babyID + "/about"

	empty := a.Do(http.MethodGet, path, cookie, nil)
	if empty.Status != http.StatusOK {
		t.Fatalf("GET before anything = %d %s", empty.Status, empty.Raw)
	}
	for _, k := range []string{"comfort", "fallsAsleep", "diet", "other"} {
		if v, present := empty.JSON[k]; !present || v != nil {
			t.Errorf("%s before anything = %v (present %v), want an explicit null", k, v, present)
		}
	}

	saved := a.Do(http.MethodPut, path, cookie, map[string]any{
		"comfort": "  Kosekanin og smokk  ", "fallsAsleep": "Bysses i vogn", "diet": "Melkeallergi", "other": "   ",
	})
	if saved.Status != http.StatusOK || saved.JSON["comfort"] != "Kosekanin og smokk" || saved.JSON["other"] != nil {
		t.Fatalf("PUT = %d %v, want trimmed text and a blank line as null", saved.Status, saved.JSON)
	}
	// PUT replaces: a line left out by sending null is cleared.
	again := a.Do(http.MethodPut, path, cookie, map[string]any{"comfort": "Kosekanin", "fallsAsleep": nil, "diet": "Melkeallergi", "other": nil})
	got := a.Do(http.MethodGet, path, cookie, nil)
	if again.Status != http.StatusOK || got.JSON["comfort"] != "Kosekanin" || got.JSON["fallsAsleep"] != nil || got.JSON["diet"] != "Melkeallergi" {
		t.Errorf("after the second PUT = %v", got.JSON)
	}

	_, other := a.NewFamily("Olsen", "other@example.com")
	if res := a.Do(http.MethodGet, path, other, nil); res.Status != http.StatusNotFound {
		t.Errorf("GET across families = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodPut, path, other, map[string]any{"comfort": "mine", "fallsAsleep": nil, "diet": nil, "other": nil}); res.Status != http.StatusNotFound {
		t.Errorf("PUT across families = %d, want 404", res.Status)
	}
	if got := a.Do(http.MethodGet, path, cookie, nil); got.JSON["comfort"] != "Kosekanin" {
		t.Errorf("the owner's text after a cross-family PUT = %v", got.JSON["comfort"])
	}
	long := make([]byte, 501)
	for i := range long {
		long[i] = 'a'
	}
	if res := a.Do(http.MethodPut, path, cookie, map[string]any{"comfort": string(long), "fallsAsleep": nil, "diet": nil, "other": nil}); res.Status != http.StatusBadRequest {
		t.Errorf("501 characters = %d, want 400", res.Status)
	}
}

// The family's own nap anchor (issue #112): set, read on the summary,
// cleared, and untouched by the text lines' PUT (and the reverse).
func TestUsualNapAnchor(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	summary := func() any {
		t.Helper()
		s := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
		v, present := s.JSON["usualNapMinute"]
		if !present {
			t.Fatalf("summary has no usualNapMinute key: %s", s.Raw)
		}
		return v
	}
	if summary() != nil {
		t.Errorf("usualNapMinute before anything = %v, want null", summary())
	}
	if res := a.Do(http.MethodPut, "/api/babies/"+babyID+"/usual-nap", cookie, map[string]any{"minute": 11*60 + 30}); res.Status != http.StatusOK {
		t.Fatalf("PUT = %d %s", res.Status, res.Raw)
	}
	if summary() != float64(690) {
		t.Errorf("usualNapMinute = %v, want 690", summary())
	}

	// The text lines' PUT replaces four lines and must leave the time alone…
	a.Do(http.MethodPut, "/api/babies/"+babyID+"/about", cookie, map[string]any{"comfort": "Kosekanin", "fallsAsleep": nil, "diet": nil, "other": nil})
	if summary() != float64(690) {
		t.Errorf("usualNapMinute after the about PUT = %v, want 690 still", summary())
	}
	// …and clearing the time leaves the lines.
	a.Do(http.MethodPut, "/api/babies/"+babyID+"/usual-nap", cookie, map[string]any{"minute": nil})
	if summary() != nil {
		t.Errorf("usualNapMinute after clearing = %v, want null", summary())
	}
	if about := a.Do(http.MethodGet, "/api/babies/"+babyID+"/about", cookie, nil); about.JSON["comfort"] != "Kosekanin" {
		t.Errorf("comfort after clearing the time = %v", about.JSON["comfort"])
	}

	for name, body := range map[string]map[string]any{"24:00": {"minute": 1440}, "a negative time": {"minute": -1}, "no minute key": {}} {
		if res := a.Do(http.MethodPut, "/api/babies/"+babyID+"/usual-nap", cookie, body); res.Status != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, res.Status)
		}
	}
	_, other := a.NewFamily("Olsen", "other@example.com")
	if res := a.Do(http.MethodPut, "/api/babies/"+babyID+"/usual-nap", other, map[string]any{"minute": 600}); res.Status != http.StatusNotFound {
		t.Errorf("across families = %d, want 404", res.Status)
	}
}
