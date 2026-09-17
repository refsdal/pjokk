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

// closingAlertGrace is how long after closing an alert is still worth
// sending. Past it the day is latched silently: the calendar reminders'
// rule, because after a cron outage a late nudge is worse than none — and
// an hour after closing the barnehage has phoned already.
const closingAlertGrace = time.Hour

// RunDaycareClosingAlerts is the third step of the */15 sweep (spec
// docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md):
// she is still at barnehage and it closes soon. One push per day there, to
// the person the family PLANNED to collect her — today's exception, else
// the weekday's person — and to the parents when nobody is named or the
// named person has left the family. Returns the number of deliveries.
//
// Every decision is made in the PLACE's timezone: "closes 16:30" is a
// wall-clock fact, the server has no zone, and the place carries the one it
// was created in, exactly as a reminder does. The closing instant is built
// with time.Date in that zone, so a clock-change day closes at 16:30 local
// like any other.
//
// The expected pick-up time plays no part. It is a plan, not a deadline
// (the owner's decision): the only thing that fires is the closing time,
// which is the barnehage's and does not move — hence no Snooze action.
//
// The latch is daycare_log.closing_alerted_at, written even when every
// delivery failed (calendar_reminders.go's reasoning: retrying each tick
// only hammers dead subscriptions). A pick-up ends the session and with it
// the candidacy. A session begun on an earlier local day is somebody's
// forgotten pick-up tap, says nothing about today, and is left alone.
func RunDaycareClosingAlerts(ctx context.Context, d Deps, now time.Time) (int, error) {
	rows, err := d.Q.ListDaycareClosingCandidates(ctx)
	if err != nil {
		return 0, fmt.Errorf("jobs: list daycare closing candidates: %w", err)
	}

	sent := 0
	for _, r := range rows {
		// Barnehage switched off for her (spec
		// 2026-09-17-per-baby-tracking-design.md): no alert and no latch,
		// so switching it on later the same day still gets one.
		tracked, err := d.Q.BabyTracks(ctx, dbgen.BabyTracksParams{FamilyID: r.FamilyID, BabyID: &r.BabyID, Feature: "daycare"})
		if err != nil {
			return sent, fmt.Errorf("jobs: tracked daycare for %s: %w", r.ID, err)
		}
		if !tracked {
			continue
		}
		loc, err := time.LoadLocation(r.Tz)
		if err != nil {
			continue // validated at creation; a corrupt row must not stall the sweep
		}
		local := now.In(loc)
		if !sameLocalDay(r.StartTime.Time.In(loc), local) {
			continue
		}
		closeAt := time.Date(local.Year(), local.Month(), local.Day(), 0, int(*r.CloseMinute), 0, 0, loc)
		if now.Before(closeAt.Add(-time.Duration(*r.AlertLeadMin) * time.Minute)) {
			continue
		}

		if now.Sub(closeAt) <= closingAlertGrace {
			targets, err := d.closingAlertTargets(ctx, r, local)
			if err != nil {
				return sent, err
			}
			for _, userID := range targets {
				lang, err := d.languageOf(ctx, userID)
				if err != nil {
					return sent, err
				}
				delivered, err := d.Push.ToUser(ctx, userID, push.PushPayload{
					Title: push.T(lang, "%s is still at daycare", r.BabyName),
					Body:  closingBody(lang, r.PlaceName, int(*r.CloseMinute), now.After(closeAt)),
					URL:   "/home",
				})
				if err != nil {
					return sent, fmt.Errorf("jobs: deliver closing alert %s to %s: %w", r.ID, userID, err)
				}
				sent += delivered
			}
		}

		if err := d.Q.MarkDaycareClosingAlerted(ctx, dbgen.MarkDaycareClosingAlertedParams{
			ClosingAlertedAt: pgtype.Timestamptz{Time: now, Valid: true},
			FamilyID:         r.FamilyID,
			ID:               r.ID,
		}); err != nil {
			return sent, fmt.Errorf("jobs: latch closing alert %s: %w", r.ID, err)
		}
	}
	return sent, nil
}

func sameLocalDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// closingAlertTargets is who hears: the planned person while they are an
// unbanned member, else the family's admins.
func (d Deps) closingAlertTargets(ctx context.Context, r dbgen.ListDaycareClosingCandidatesRow, local time.Time) ([]string, error) {
	// ISO weekday, 1 = Monday. A weekend has no grid row and resolves to the
	// exception or nobody.
	weekday := int32(local.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	planned, err := d.Q.PlannedPickupUser(ctx, dbgen.PlannedPickupUserParams{
		FamilyID: r.FamilyID,
		BabyID:   r.BabyID,
		Date:     pgtype.Date{Time: date, Valid: true},
		Weekday:  weekday,
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return nil, fmt.Errorf("jobs: planned pick-up for %s: %w", r.ID, err)
	default:
		member, err := d.Q.IsUnbannedFamilyMember(ctx, dbgen.IsUnbannedFamilyMemberParams{FamilyID: r.FamilyID, UserID: planned})
		if err != nil {
			return nil, fmt.Errorf("jobs: membership of %s: %w", planned, err)
		}
		if member {
			return []string{planned}, nil
		}
	}
	admins, err := d.Q.ListFamilyAdminUserIDs(ctx, r.FamilyID)
	if err != nil {
		return nil, fmt.Errorf("jobs: admins of %s: %w", r.FamilyID, err)
	}
	return admins, nil
}

func closingBody(lang, place string, closeMinute int, past bool) string {
	clock := fmt.Sprintf("%02d:%02d", closeMinute/60, closeMinute%60)
	if past {
		return push.T(lang, "%s closed at %s", place, clock)
	}
	return push.T(lang, "%s closes at %s", place, clock)
}
