package jobs

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
)

// RunFeedReminders is the Go port of apps/api/src/jobs/reminders.ts's
// runReminders: one nudge per feeding gap. A caretaker with
// feedReminderHours=N gets a push when the family hasn't logged a feed for N
// hours — once, until a new feed starts a new gap (lastRemindedAt < lastFeed
// gates re-sending). Returns the total number of deliveries across every
// pref (a caretaker with N subscribed devices counts N, same as
// push.Sender.ToUser's own return).
func RunFeedReminders(ctx context.Context, d Deps, now time.Time) (int, error) {
	prefs, err := d.Q.ListFeedReminderPrefs(ctx)
	if err != nil {
		return 0, fmt.Errorf("jobs: list feed reminder prefs: %w", err)
	}

	sent := 0
	for _, pref := range prefs {
		maxTime, err := d.Q.MaxFeedTimeForFamily(ctx, pref.FamilyID)
		if err != nil {
			return sent, fmt.Errorf("jobs: max feed time for %s: %w", pref.FamilyID, err)
		}
		if !maxTime.Valid {
			// The family has never logged a feed — nothing to gap against.
			continue
		}
		lastFeed := maxTime.Time

		gap := now.Sub(lastFeed)
		threshold := time.Duration(pref.FeedReminderHours) * time.Hour
		alreadyReminded := pref.LastRemindedAt.Valid && !pref.LastRemindedAt.Time.Before(lastFeed)
		if gap < threshold || alreadyReminded {
			continue
		}

		hours := int(gap / time.Hour)
		delivered, err := d.Push.ToUser(ctx, pref.UserID, push.PushPayload{
			Title: "Pjokk",
			Body:  fmt.Sprintf("No feed logged for %d h", hours),
			URL:   "/home",
		})
		if err != nil {
			return sent, fmt.Errorf("jobs: deliver feed reminder to %s: %w", pref.UserID, err)
		}
		sent += delivered

		if err := d.Q.SetPushPrefLastReminded(ctx, dbgen.SetPushPrefLastRemindedParams{
			LastRemindedAt: pgtype.Timestamptz{Time: now, Valid: true},
			UserID:         pref.UserID,
			FamilyID:       pref.FamilyID,
		}); err != nil {
			return sent, fmt.Errorf("jobs: stamp last_reminded_at for %s: %w", pref.UserID, err)
		}
	}
	return sent, nil
}
