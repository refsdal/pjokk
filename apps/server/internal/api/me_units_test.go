package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #53: display units are a per-user preference on /api/me — metric
// by default, settable to imperial, rejected otherwise, and untouched by a
// PATCH that does not mention them.
func TestMeUnitsPreference(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if me := a.Do(http.MethodGet, "/api/me", cookie, nil); me.JSON["units"] != "metric" {
		t.Fatalf("default units = %v, want metric", me.JSON["units"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"units": "imperial"}); res.Status != http.StatusOK || res.JSON["units"] != "imperial" {
		t.Fatalf("set imperial = %d %v", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"nickname": "Pappa"}); res.JSON["units"] != "imperial" {
		t.Errorf("a nickname PATCH changed units to %v", res.JSON["units"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"units": "stone"}); res.Status != http.StatusBadRequest {
		t.Errorf("units=stone = %d, want 400", res.Status)
	}
	if me := a.Do(http.MethodGet, "/api/me", cookie, nil); me.JSON["units"] != "imperial" {
		t.Errorf("units after the rejected PATCH = %v, want imperial", me.JSON["units"])
	}
}
