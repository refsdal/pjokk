package jobs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
)

// RunReminders is the */15 sweep over every reminder row (issue #45). It
// grew out of apps/api/src/jobs/reminders.ts's runReminders, whose one rule
// — a nudge per feeding gap, once, until a new feed starts a new gap — is
// now the `since_last` mode applied per kind; `at_time` adds fixed daily
// slots. Returns the total number of deliveries (a caretaker with N
// subscribed devices counts N, as push.Sender.ToUser does).
//
// Every decision is made on the reminder's own timezone: at_minute, days
// and quiet hours are wall-clock concepts, and users have no timezone
// column, so each row carries the zone the phone was in when it was
// created (time/tzdata is embedded, see calendar_reminders.go).
//
// Two latches, one column. last_fired_at means "the newest thing this
// reminder has answered": for since_last that is the log it fired against
// (a later log clears it by being newer), for at_time the day slot it fired
// for (tomorrow's slot is newer). Quiet hours HOLD rather than latch, so a
// gap that came due at 03:00 still fires at the first tick after 07:00.
//
// A fixed slot more than an hour past is latched without sending, exactly
// as calendar reminders are — after a cron outage a late nudge is worse
// than none. An interval gap has no such cutoff: "no feed for 9 h" is worth
// saying however late the cron wakes up.
func RunReminders(ctx context.Context, d Deps, now time.Time) (int, error) {
	rows, err := d.Q.ListAllReminders(ctx)
	if err != nil {
		return 0, fmt.Errorf("jobs: list reminders: %w", err)
	}

	sent := 0
	for _, r := range rows {
		loc, err := time.LoadLocation(r.Tz)
		if err != nil {
			// Validated at creation; a corrupt row must not stall the sweep.
			continue
		}
		local := now.In(loc)

		if !dayEnabled(r.DaysMask, local.Weekday()) {
			continue
		}
		if r.QuietStart != nil && r.QuietEnd != nil && inQuietHours(local.Hour(), int(*r.QuietStart), int(*r.QuietEnd)) {
			continue
		}

		var fire bool
		var body string
		switch r.Mode {
		case "since_last":
			last, err := d.lastLogTime(ctx, r)
			if err != nil {
				return sent, err
			}
			if !last.Valid {
				continue // never logged: nothing to gap against
			}
			gap := now.Sub(last.Time)
			if gap < time.Duration(*r.IntervalMin)*time.Minute {
				continue
			}
			if r.LastFiredAt.Valid && !r.LastFiredAt.Time.Before(last.Time) {
				continue // already nudged for this gap
			}
			fire = true
			body = gapBody(r, gap)
		case "at_time":
			slot := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc).Add(time.Duration(*r.AtMinute) * time.Minute)
			if now.Before(slot) {
				continue
			}
			if r.LastFiredAt.Valid && !r.LastFiredAt.Time.Before(slot) {
				continue // this slot is done
			}
			if now.Sub(slot) > time.Hour {
				// Missed by more than the grace window: latch, stay silent.
				if err := d.stampReminder(ctx, r.ID, now); err != nil {
					return sent, err
				}
				continue
			}
			fire = true
			body = slotBody(r)
		}
		if !fire {
			continue
		}

		name, err := d.babyName(ctx, r)
		if err != nil {
			return sent, err
		}
		if name != "" {
			body = name + ": " + body
		}
		delivered, err := d.Push.ToUser(ctx, r.UserID, push.PushPayload{
			Title:   "Pjokk",
			Body:    body,
			URL:     "/home",
			Actions: reminderActions(r.Kind),
		})
		if err != nil {
			return sent, fmt.Errorf("jobs: deliver reminder %s to %s: %w", r.ID, r.UserID, err)
		}
		sent += delivered
		if err := d.stampReminder(ctx, r.ID, now); err != nil {
			return sent, err
		}
	}
	return sent, nil
}

// dayEnabled reads the days mask: bit 0 = Monday … bit 6 = Sunday (Go's
// Weekday has Sunday = 0, so it is rotated).
func dayEnabled(mask int32, wd time.Weekday) bool {
	bit := (int(wd) + 6) % 7
	return mask&(1<<bit) != 0
}

// inQuietHours is the night-mode window rule (lib/night.ts inNightWindow):
// [start, end) with a window that may cross midnight; start == end is an
// empty window, never a 24-hour one.
func inQuietHours(hour, start, end int) bool {
	if start == end {
		return false
	}
	if start > end {
		return hour >= start || hour < end
	}
	return hour >= start && hour < end
}

func (d Deps) lastLogTime(ctx context.Context, r dbgen.Reminder) (pgtype.Timestamptz, error) {
	switch r.Kind {
	case "feed":
		return d.Q.LastFeedTime(ctx, dbgen.LastFeedTimeParams{FamilyID: r.FamilyID, BabyID: r.BabyID})
	case "diaper":
		return d.Q.LastDiaperTime(ctx, dbgen.LastDiaperTimeParams{FamilyID: r.FamilyID, BabyID: r.BabyID})
	case "pump":
		return d.Q.LastPumpTime(ctx, dbgen.LastPumpTimeParams{FamilyID: r.FamilyID, BabyID: r.BabyID})
	case "medicine":
		return d.Q.LastMedicineTime(ctx, dbgen.LastMedicineTimeParams{FamilyID: r.FamilyID, BabyID: r.BabyID, Name: r.Label})
	}
	return pgtype.Timestamptz{}, nil
}

func (d Deps) stampReminder(ctx context.Context, id string, now time.Time) error {
	if err := d.Q.SetReminderLastFired(ctx, dbgen.SetReminderLastFiredParams{
		ID:          id,
		LastFiredAt: pgtype.Timestamptz{Time: now, Valid: true},
	}); err != nil {
		return fmt.Errorf("jobs: stamp reminder %s: %w", id, err)
	}
	return nil
}

// babyName prefixes a baby-scoped reminder's text; a baby deleted since
// (the row cascades, but the sweep may hold an older list) is simply blank.
func (d Deps) babyName(ctx context.Context, r dbgen.Reminder) (string, error) {
	if r.BabyID == nil {
		return "", nil
	}
	baby, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: r.FamilyID, ID: *r.BabyID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("jobs: baby for reminder %s: %w", r.ID, err)
	}
	return baby.Name, nil
}

func gapBody(r dbgen.Reminder, gap time.Duration) string {
	hours := int(gap / time.Hour)
	mins := int(gap/time.Minute) % 60
	since := fmt.Sprintf("%d h", hours)
	if hours == 0 {
		since = fmt.Sprintf("%d min", mins)
	}
	switch r.Kind {
	case "diaper":
		return fmt.Sprintf("No diaper change logged for %s", since)
	case "pump":
		return fmt.Sprintf("No pump logged for %s", since)
	case "medicine":
		if r.Label != nil {
			return fmt.Sprintf("%s: %s since the last dose", *r.Label, since)
		}
		return fmt.Sprintf("No medicine logged for %s", since)
	}
	return fmt.Sprintf("No feed logged for %s", since)
}

func slotBody(r dbgen.Reminder) string {
	if r.Label != nil {
		return *r.Label
	}
	switch r.Kind {
	case "diaper":
		return "Diaper reminder"
	case "pump":
		return "Time to pump"
	case "medicine":
		return "Medicine reminder"
	}
	return "Feed reminder"
}

// reminderActions is the notification's "log it now" button (issue #51):
// the deep link Home understands (screens/Home.tsx reads ?log=), which
// opens the matching sheet with the time at now. A custom reminder has no
// sheet to open.
func reminderActions(kind string) []push.PushAction {
	switch kind {
	case "feed":
		return []push.PushAction{{Action: "log", Title: "Log feed", URL: "/home?log=feed"}}
	case "diaper":
		return []push.PushAction{{Action: "log", Title: "Log diaper", URL: "/home?log=diaper"}}
	case "pump":
		return []push.PushAction{{Action: "log", Title: "Log pump", URL: "/home?log=pump"}}
	case "medicine":
		return []push.PushAction{{Action: "log", Title: "Log dose", URL: "/home?log=medicine"}}
	}
	return nil
}
