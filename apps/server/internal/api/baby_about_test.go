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
