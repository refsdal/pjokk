package jobs

// Snoozed reminders (DECISIONS 2026-09-11; 00017_push_snooze.sql). A tap on
// a notification's Snooze button leaves a push_snooze row due 15 minutes
// after that notification went out; the frequent job sends it again then,
// to that one person, rebuilt from the reminder or calendar event as it is
// at that moment — with a Snooze button of its own.

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

// snoozeGrace lets a snooze due a moment after this tick go out on it
// rather than a whole tick later: cron fires a little after the quarter
// hour, and never at exactly the same offset twice.
const snoozeGrace = 2 * time.Minute

// snoozeFate is what this tick does with one due snooze.
type snoozeFate int

const (
	snoozeSend snoozeFate = iota
	snoozeDrop            // nothing left to say: deleted, or answered
	snoozeHold            // the reminder's quiet hours: try the next tick
)

// RunSnoozes sends every snoozed reminder that is due and returns the
// number of deliveries. A row is deleted before its push goes out: one
// shot, so a failed delivery is not retried every tick. Quiet hours hold a
// snooze rather than drop it, as they hold a reminder.
func RunSnoozes(ctx context.Context, d Deps, now time.Time) (int, error) {
	due, err := d.Q.ListDuePushSnoozes(ctx, pgtype.Timestamptz{Time: now.Add(snoozeGrace), Valid: true})
	if err != nil {
		return 0, fmt.Errorf("jobs: list snoozes: %w", err)
	}
	sent := 0
	for _, s := range due {
		payload, fate, err := d.snoozedPayload(ctx, s, now)
		if err != nil {
			return sent, err
		}
		if fate == snoozeHold {
			continue
		}
		if err := d.Q.DeletePushSnooze(ctx, s.ID); err != nil {
			return sent, fmt.Errorf("jobs: drop snooze %s: %w", s.ID, err)
		}
		if fate == snoozeDrop {
			continue
		}
		delivered, err := d.Push.ToUser(ctx, s.UserID, payload)
		if err != nil {
			return sent, fmt.Errorf("jobs: deliver snoozed reminder to %s: %w", s.UserID, err)
		}
		sent += delivered
	}
	return sent, nil
}

// snoozedPayload rebuilds the notification a snooze stands for, as the
// reminder or event is now, with a fresh Snooze button of its own.
func (d Deps) snoozedPayload(ctx context.Context, s dbgen.PushSnooze, now time.Time) (push.PushPayload, snoozeFate, error) {
	again := push.SnoozeClaims{Source: s.Source, ID: s.SourceID, UserID: s.UserID, FamilyID: s.FamilyID, SentAt: now}
	switch s.Source {
	case push.SnoozeReminder:
		r, err := d.Q.GetReminder(ctx, dbgen.GetReminderParams{ID: s.SourceID, UserID: s.UserID, FamilyID: s.FamilyID})
		if errors.Is(err, pgx.ErrNoRows) {
			return push.PushPayload{}, snoozeDrop, nil
		}
		if err != nil {
			return push.PushPayload{}, snoozeDrop, fmt.Errorf("jobs: snoozed reminder %s: %w", s.SourceID, err)
		}
		if loc, err := time.LoadLocation(r.Tz); err == nil && r.QuietStart != nil && r.QuietEnd != nil &&
			inQuietHours(now.In(loc).Hour(), int(*r.QuietStart), int(*r.QuietEnd)) {
			return push.PushPayload{}, snoozeHold, nil
		}
		last, err := d.lastLogTime(ctx, r)
		if err != nil {
			return push.PushPayload{}, snoozeDrop, err
		}
		if answered(r, last, s.SentAt.Time, now) {
			return push.PushPayload{}, snoozeDrop, nil
		}
		body := slotBody(r)
		if r.Mode == "since_last" && last.Valid {
			body = gapBody(r, now.Sub(last.Time))
		}
		name, err := d.babyName(ctx, r)
		if err != nil {
			return push.PushPayload{}, snoozeDrop, err
		}
		if name != "" {
			body = name + ": " + body
		}
		return push.PushPayload{
			Title:   "Pjokk",
			Body:    body,
			URL:     "/home",
			Actions: append(reminderActions(r.Kind), push.SnoozeAction(d.SnoozeKey, again)),
		}, snoozeSend, nil

	case push.SnoozeCalendar:
		ev, err := d.Q.GetCalendarEvent(ctx, dbgen.GetCalendarEventParams{FamilyID: s.FamilyID, ID: s.SourceID})
		if errors.Is(err, pgx.ErrNoRows) {
			return push.PushPayload{}, snoozeDrop, nil
		}
		if err != nil {
			return push.PushPayload{}, snoozeDrop, fmt.Errorf("jobs: snoozed event %s: %w", s.SourceID, err)
		}
		body := ev.Title
		if s.OccurrenceStart.Valid {
			occ := s.OccurrenceStart.Time
			again.Occurrence = &occ
			if !ev.AllDay {
				body = fmt.Sprintf("%s · %s", ev.Title, FormatOsloClock(occ))
			}
		}
		return push.PushPayload{
			Title:   "Pjokk",
			Body:    body,
			URL:     "/calendar",
			Actions: []push.PushAction{push.SnoozeAction(d.SnoozeKey, again)},
		}, snoozeSend, nil
	}
	return push.PushPayload{}, snoozeDrop, nil
}

// answered reports whether the reminder's kind has been logged since the
// snoozed notification went out, which cancels the snooze. That is a log
// timed after it, or up to 15 minutes before it: the log sheet's "15 m
// ago" chip is how a feed given before the tap gets logged after it. A
// since_last reminder is also answered once its gap is back under the
// interval, whatever log closed it.
func answered(r dbgen.Reminder, last pgtype.Timestamptz, sentAt, now time.Time) bool {
	if !last.Valid {
		return false
	}
	if last.Time.After(sentAt.Add(-push.SnoozeFor)) {
		return true
	}
	return r.Mode == "since_last" && r.IntervalMin != nil &&
		now.Sub(last.Time) < time.Duration(*r.IntervalMin)*time.Minute
}
