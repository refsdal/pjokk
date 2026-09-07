package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #52: recurring events are one row expanded at read time.

func TestListCalendarEventsExpandsSeriesInWindow(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	// Weekly physio, Mondays 10:00 Oslo, ending after three weeks.
	start := time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC) // 10:00 CET
	until := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Physio", "category": "doctor",
		"startTime": start.Format(time.RFC3339), "durationMin": 45,
		"recurrence": "weekly", "recurrenceUntil": until.Format(time.RFC3339),
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Status, created.Raw)
	}
	if created.JSON["recurrence"] != "weekly" || created.JSON["recurrenceUntil"] != until.Format(time.RFC3339) || created.JSON["seriesStart"] != start.Format(time.RFC3339) {
		t.Errorf("created = %v", created.JSON)
	}
	id, _ := created.JSON["id"].(string)
	// A one-off in the same window, and one the day before the series.
	a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Vaccine", "startTime": time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC).Format(time.RFC3339),
	})

	listed := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)), cookie, nil)
	if listed.Status != http.StatusOK {
		t.Fatalf("list = %d %s", listed.Status, listed.Raw)
	}
	var got []string
	for _, e := range listed.JSON {
		m, _ := e.(map[string]any)
		got = append(got, m["title"].(string)+"@"+m["startTime"].(string))
	}
	want := []string{
		"Physio@2026-03-02T09:00:00Z",
		"Physio@2026-03-09T09:00:00Z",
		"Vaccine@2026-03-10T12:00:00Z",
		"Physio@2026-03-16T09:00:00Z",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("listed = %v, want %v", got, want)
	}
	for _, e := range listed.JSON {
		m, _ := e.(map[string]any)
		if m["title"] == "Physio" && (m["id"] != id || m["seriesStart"] != start.Format(time.RFC3339)) {
			t.Errorf("occurrence %v should carry the series id and seriesStart", m)
		}
	}

	// A later window still sees the series as long as it is open; after
	// `until` there is nothing.
	if later := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)), cookie, nil); len(later.JSON) != 0 {
		t.Errorf("after until = %s, want nothing", later.Raw)
	}

	// PATCH the rule: daily across a DST change keeps the local clock, and
	// a PATCH back to none drops the end date.
	patched := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"recurrence": "daily", "recurrenceUntil": nil})
	if patched.Status != http.StatusOK || patched.JSON["recurrence"] != "daily" || patched.JSON["recurrenceUntil"] != nil {
		t.Fatalf("patched = %d %v", patched.Status, patched.JSON)
	}
	dst := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(time.Date(2026, 3, 28, 0, 0, 0, 0, time.UTC), time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)), cookie, nil)
	var starts []string
	for _, e := range dst.JSON {
		m, _ := e.(map[string]any)
		starts = append(starts, m["startTime"].(string))
	}
	// 10:00 CET is 09:00Z on the 28th; 10:00 CEST is 08:00Z from the 29th.
	if strings.Join(starts, " ") != "2026-03-28T09:00:00Z 2026-03-29T08:00:00Z 2026-03-30T08:00:00Z" {
		t.Errorf("daily across DST = %v", starts)
	}
	back := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"recurrence": "none"})
	if back.JSON["recurrence"] != "none" || back.JSON["recurrenceUntil"] != nil {
		t.Errorf("back to one-off = %v", back.JSON)
	}
}

func TestUpdateCalendarEventRecurrenceRearmsLatch(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Vitamin D", "startTime": futureISO(24 * hour), "remindMinutesBefore": 60,
	})
	id, _ := created.JSON["id"].(string)
	ctx := context.Background()
	if _, err := a.Deps.Pool.Exec(ctx, `UPDATE "calendar_event" SET "reminded_at" = now() WHERE "id" = $1`, id); err != nil {
		t.Fatal(err)
	}
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"recurrence": "daily"}); res.Status != http.StatusOK {
		t.Fatalf("patch = %d %s", res.Status, res.Raw)
	}
	var remindedAt *time.Time
	if err := a.Deps.Pool.QueryRow(ctx, `SELECT "reminded_at" FROM "calendar_event" WHERE "id" = $1`, id).Scan(&remindedAt); err != nil {
		t.Fatal(err)
	}
	if remindedAt != nil {
		t.Errorf("reminded_at after a recurrence PATCH = %v, want NULL", *remindedAt)
	}
}
