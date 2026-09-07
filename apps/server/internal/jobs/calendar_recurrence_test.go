package jobs_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #52: a series is reminded once per occurrence — the latch is the
// occurrence's start — and a stale occurrence is skipped, not fired late.
func TestCalendarRemindersFirePerOccurrence(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	subscribePush(t, a, cookie, "https://fcm.googleapis.com/rec/admin")

	start := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)
	id := createCalendarEvent(t, a, cookie, map[string]any{
		"title": "Vitamin D", "startTime": start.Format(time.RFC3339),
		"remindMinutesBefore": 15, "recurrence": "daily",
	})
	d := depsFor(a)
	ctx := context.Background()
	run := func(now time.Time) int {
		t.Helper()
		sent, err := jobs.RunCalendarReminders(ctx, d, now)
		if err != nil {
			t.Fatalf("RunCalendarReminders at %v: %v", now, err)
		}
		return sent
	}

	// Day 1: 20 min before → not yet; 10 min before → fires; again → latched.
	if got := run(start.Add(-20 * time.Minute)); got != 0 {
		t.Errorf("20 min before = %d, want 0", got)
	}
	if got := run(start.Add(-10 * time.Minute)); got != 1 {
		t.Errorf("10 min before = %d, want 1", got)
	}
	if got := run(start.Add(-5 * time.Minute)); got != 0 {
		t.Errorf("repeat = %d, want 0", got)
	}
	if latched := calendarEventRemindedAt(t, a, id); latched == nil || !latched.Equal(start) {
		t.Errorf("reminded_at = %v, want the occurrence start %v", latched, start)
	}
	// Day 2 fires again (the same row, the next occurrence).
	day2 := start.Add(24 * time.Hour)
	if got := run(day2.Add(-10 * time.Minute)); got != 1 {
		t.Errorf("day 2 = %d, want 1", got)
	}
	// A week of downtime: the missed occurrences are not fired late, but
	// the next upcoming one is, once its lead has elapsed.
	day9 := start.Add(8 * 24 * time.Hour)
	if got := run(day9.Add(-30 * time.Minute)); got != 0 {
		t.Errorf("after downtime, before the lead = %d, want 0", got)
	}
	if got := run(day9.Add(-10 * time.Minute)); got != 1 {
		t.Errorf("after downtime, inside the lead = %d, want 1", got)
	}
	if got := a.Push.Count(adminID); got != 3 {
		t.Errorf("deliveries = %d, want 3", got)
	}

	// Ending the series silences it.
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"recurrenceUntil": day9.Format(time.RFC3339)}); res.Status != http.StatusOK {
		t.Fatalf("patch until: %d %s", res.Status, res.Raw)
	}
	if got := run(day9.Add(24*time.Hour - 10*time.Minute)); got != 0 {
		t.Errorf("past until = %d, want 0", got)
	}
}
