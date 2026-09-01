package jobs

import (
	"context"
	"fmt"
	"time"

	// Embeds the IANA time zone database in the binary. Without this,
	// time.LoadLocation("Europe/Oslo") depends on /usr/share/zoneinfo (or
	// ZONEINFO) existing on whatever host or container runs the job — a
	// minimal container image is exactly the case where that is NOT a safe
	// assumption. REF §A7 / the calendar-reminders.test.ts port both require
	// Oslo-local formatting to be correct regardless of the runtime image, so
	// the dependency is removed rather than documented as an operational
	// requirement.
	_ "time/tzdata"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
)

// osloLocation is loaded once at package init. time/tzdata guarantees this
// never fails at runtime (the embedded database always has "Europe/Oslo"),
// so a package-level panic on lookup failure is appropriate here — it would
// mean the embedded tzdata itself is broken, not a transient condition any
// caller could recover from.
var osloLocation = mustLoadLocation("Europe/Oslo")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("jobs: load location %q: %v", name, err))
	}
	return loc
}

// FormatOsloClock renders t as 24-hour "HH:mm" in Europe/Oslo — the Go port
// of calendar-reminders.ts's exported `clockFmt`. Exported for the same
// reason: calendar_reminders_test.go asserts this directly, since the
// pushed body itself isn't observable through a test's push stand-in
// (web-push encrypts the JSON payload before any HTTP call the real sender
// makes; the port's RecordingPush sidesteps encryption entirely, but the
// TEST still wants a direct, unit-level assertion that a 14:00 CEST
// appointment renders as "14:00", not workerd/UTC's "12:00").
func FormatOsloClock(t time.Time) string {
	return t.In(osloLocation).Format("15:04")
}

// RunCalendarReminders is the Go port of
// apps/api/src/jobs/calendar-reminders.ts's runCalendarReminders. Push when
// now enters [start − lead, start]; remindedAt is the idempotency latch
// (same idea as feed reminders' lastRemindedAt — editing an event's time or
// lead resets it, see internal/api/calendar.go's UpdateCalendarEvent). Events
// whose start is more than an hour past are latched WITHOUT sending — after
// downtime a late reminder is worse than none. Returns the total number of
// deliveries across every due event.
func RunCalendarReminders(ctx context.Context, d Deps, now time.Time) (int, error) {
	nowTS := pgtype.Timestamptz{Time: now, Valid: true}
	graceFloor := pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true}

	// Grace window: latch long-past events so they never fire late.
	if _, err := d.Q.LatchStaleCalendarReminders(ctx, dbgen.LatchStaleCalendarRemindersParams{
		RemindedAt: nowTS,
		StartTime:  graceFloor,
	}); err != nil {
		return 0, fmt.Errorf("jobs: latch stale calendar reminders: %w", err)
	}

	due, err := d.Q.ListDueCalendarReminders(ctx, dbgen.ListDueCalendarRemindersParams{
		StartTime:   graceFloor,
		StartTime_2: nowTS,
	})
	if err != nil {
		return 0, fmt.Errorf("jobs: list due calendar reminders: %w", err)
	}

	sent := 0
	for _, event := range due {
		assignees, err := d.Q.CalendarEventAssigneeUserIDs(ctx, event.ID)
		if err != nil {
			return sent, fmt.Errorf("jobs: assignees for event %s: %w", event.ID, err)
		}

		targets := assignees
		if len(targets) == 0 {
			targets, err = d.Q.ListFamilyMemberUserIDs(ctx, event.FamilyID)
			if err != nil {
				return sent, fmt.Errorf("jobs: family members for %s: %w", event.FamilyID, err)
			}
		}

		body := event.Title
		if !event.AllDay {
			body = fmt.Sprintf("%s · %s", event.Title, FormatOsloClock(event.StartTime.Time))
		}

		for _, userID := range targets {
			delivered, err := d.Push.ToUser(ctx, userID, push.PushPayload{
				Title: "Pjokk",
				Body:  body,
				URL:   "/calendar",
			})
			if err != nil {
				return sent, fmt.Errorf("jobs: deliver calendar reminder to %s: %w", userID, err)
			}
			sent += delivered
		}

		// Latch even when every delivery failed — retrying each cron tick
		// would hammer dead subscriptions for no benefit.
		if err := d.Q.MarkCalendarEventReminded(ctx, dbgen.MarkCalendarEventRemindedParams{
			RemindedAt: nowTS,
			ID:         event.ID,
		}); err != nil {
			return sent, fmt.Errorf("jobs: latch calendar event %s: %w", event.ID, err)
		}
	}
	return sent, nil
}
