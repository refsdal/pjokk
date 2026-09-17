package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Barnehage on the calendar (issue #110): a category of its own and a
// "closed" flag that means something only there.
func TestCalendarDaycareCategoryAndClosedFlag(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	day := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)

	planning := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Planleggingsdag", "category": "daycare", "closed": true, "allDay": true, "startTime": rfc(day),
	})
	if planning.Status != http.StatusCreated || planning.JSON["category"] != "daycare" || planning.JSON["closed"] != true {
		t.Fatalf("a closed barnehage day = %d %v", planning.Status, planning.JSON)
	}
	id, _ := planning.JSON["id"].(string)

	// Open by default, and the flag is present on the wire either way.
	meeting := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Foreldremøte", "category": "daycare", "startTime": rfc(day.Add(42 * time.Hour)),
	})
	if v, present := meeting.JSON["closed"]; !present || v != false {
		t.Errorf("closed when not sent = %v (present %v), want false", v, present)
	}
	// It is a fact about barnehage: on any other category it is stored false.
	doctor := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Helsestasjon", "category": "doctor", "closed": true, "startTime": rfc(day.Add(72 * time.Hour)),
	})
	if doctor.Status != http.StatusCreated || doctor.JSON["closed"] != false {
		t.Errorf("closed on a doctor's appointment = %v, want false", doctor.JSON["closed"])
	}

	// The list carries it (Home reads the list).
	list := a.Do(http.MethodGet, "/api/calendar/events?from="+rfc(day.Add(-time.Hour))+"&to="+rfc(day.Add(24*time.Hour)), cookie, nil)
	if !strings.Contains(string(list.Raw), `"closed":true`) {
		t.Errorf("list = %s, want the closed day", list.Raw)
	}

	// Reopened, closed again, then moved out of the category: the flag goes
	// with it rather than linger where nothing shows it.
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"closed": false}); res.JSON["closed"] != false {
		t.Errorf("PATCH closed:false = %v", res.JSON["closed"])
	}
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"closed": true}); res.JSON["closed"] != true {
		t.Errorf("PATCH closed:true = %v", res.JSON["closed"])
	}
	moved := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"category": "family"})
	if moved.Status != http.StatusOK || moved.JSON["category"] != "family" || moved.JSON["closed"] != false {
		t.Errorf("moved to family = %d %v, want closed cleared", moved.Status, moved.JSON)
	}
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"closed": true}); res.JSON["closed"] != false {
		t.Errorf("closed:true on a family event = %v, want false", res.JSON["closed"])
	}
	if res := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{"title": "x", "category": "school", "startTime": rfc(day)}); res.Status != http.StatusBadRequest {
		t.Errorf("an unknown category = %d, want 400", res.Status)
	}
}

// One closed day of a weekly series, detached: it keeps the category and
// the flag it was given.
func TestCalendarDetachedOccurrenceKeepsClosed(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	start := time.Date(2026, 10, 5, 7, 0, 0, 0, time.UTC)
	series := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Barnehage", "category": "daycare", "startTime": rfc(start), "recurrence": "weekly",
	})
	id, _ := series.JSON["id"].(string)
	second := start.Add(7 * 24 * time.Hour)
	detached := a.Do(http.MethodPatch, "/api/calendar/events/"+id+"?occurrence="+rfc(second), cookie, map[string]any{"closed": true, "title": "Stengt: høstferie"})
	if detached.Status != http.StatusOK || detached.JSON["closed"] != true || detached.JSON["category"] != "daycare" || detached.JSON["id"] == id {
		t.Fatalf("detached = %d %v, want a new closed barnehage event", detached.Status, detached.JSON)
	}
	if still := a.Do(http.MethodGet, "/api/calendar/events?from="+rfc(start.Add(-time.Hour))+"&to="+rfc(start.Add(time.Hour)), cookie, nil); strings.Contains(string(still.Raw), `"closed":true`) {
		t.Errorf("the series itself became closed: %s", still.Raw)
	}
}
