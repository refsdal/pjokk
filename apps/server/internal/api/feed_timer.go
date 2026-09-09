package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Shared nursing / pump timer (issue #44). The running state is a
// feed_timer row per (baby, kind) — see 00008_feed_timer.sql for why it is
// its own table and not a feed_log row with a NULL end — and every
// caretaker reads the same row through /api/summary's activeFeed /
// activePump, exactly as they read a running sleep.
//
// # The clock is the server's
//
// A timer banks seconds per side. The client never sends elapsed time: it
// sends "switch to right", "pause", "stop", and the server adds the stretch
// that was running (now minus side_started_at, on d.Now()) to the banked
// total before writing the new state. Two phones therefore agree without
// any clock sync, and a Home Assistant automation can drive the timer with
// the same three calls. The one exception is start: an offline SPA replays
// the moment the parent actually tapped Start, so StartFeedTimer accepts a
// client startTime (TestFeedTimerHonoursClientStartTime).
//
// # Stop is a transaction
//
// Stopping turns the timer into a feed_log (nursing) or pump_log (pump) row
// and deletes the timer, in one transaction. The DELETE's rows-affected
// count is the replay guard: a second stop for the same id finds nothing
// to delete, the transaction rolls back the row it just inserted, and the
// caller gets a 404 rather than a duplicate feed — the same property
// sleep.sql's WakeSleep gets from its "end_time IS NULL" predicate.
//
// # Minutes from seconds
//
// The sheet's rule, ported verbatim from the old localStorage timer: a side
// with any seconds at all is at least one minute (a 20-second latch still
// registers), otherwise rounded to the nearest minute. The sheet's steppers
// can override either side through StopFeedTimer's body, because a parent
// who forgot to stop the clock knows better than the clock.

func alreadyActiveFeedTimer() gen.Error {
	return gen.Error{Error: "Already running", Code: "ALREADY_ACTIVE"}
}

func noFeedTimer() gen.Error {
	return gen.Error{Error: "No running timer", Code: "NOT_FOUND"}
}

// serFeedTimer converts one joined feed_timer+users row into the wire
// shape. GetFeedTimer and ActiveFeedTimer produce two names for this one
// shape; callers holding the other convert (see convert.go).
func serFeedTimer(r dbgen.GetFeedTimerRow) gen.FeedTimer {
	return gen.FeedTimer{
		Id:            r.ID,
		BabyId:        r.BabyID,
		CaretakerId:   r.CaretakerID,
		CaretakerName: r.CaretakerName,
		Kind:          gen.FeedTimerKind(r.Kind),
		StartTime:     r.StartTime.Time,
		RunningSide:   enumPtr[gen.FeedTimerRunningSide](r.RunningSide),
		SideStartedAt: tsPtr(r.SideStartedAt),
		LeftSec:       r.LeftSec,
		RightSec:      r.RightSec,
	}
}

// bankedSeconds is the banked totals plus whatever stretch is running, as
// of now. "right" banks right; left and both bank left — a pump timer is
// one clock and everything it counts lands in leftSec.
func bankedSeconds(runningSide *string, sideStartedAt pgtype.Timestamptz, leftSec, rightSec int32, now time.Time) (int32, int32) {
	if runningSide == nil || !sideStartedAt.Valid {
		return leftSec, rightSec
	}
	d := now.Sub(sideStartedAt.Time)
	if d < 0 {
		d = 0
	}
	add := int32(d / time.Second)
	if *runningSide == "right" {
		return leftSec, rightSec + add
	}
	return leftSec + add, rightSec
}

func minutesFromSeconds(sec int32) int32 {
	if sec <= 0 {
		return 0
	}
	m := (sec + 30) / 60
	if m < 1 {
		m = 1
	}
	return m
}

// activeFeedTimer is the summary's read: the running timer of one kind for
// a baby, or nil.
func (d Deps) activeFeedTimer(ctx context.Context, familyID, babyID, kind string) (*gen.FeedTimer, error) {
	row, err := d.Q.ActiveFeedTimer(ctx, dbgen.ActiveFeedTimerParams{FamilyID: familyID, BabyID: babyID, Kind: kind})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	v := serFeedTimer(dbgen.GetFeedTimerRow(row))
	return &v, nil
}

// GetFeedTimer implements GET /api/feeds/timer: both kinds for one baby.
func (d Deps) GetFeedTimer(ctx context.Context, req gen.GetFeedTimerRequestObject) (gen.GetFeedTimerResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: req.Params.BabyId}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.GetFeedTimer404JSONResponse(unknownBabyErr()), nil
		}
		return nil, err
	}
	breast, err := d.activeFeedTimer(ctx, fam.FamilyID, req.Params.BabyId, "breast")
	if err != nil {
		return nil, err
	}
	pump, err := d.activeFeedTimer(ctx, fam.FamilyID, req.Params.BabyId, "pump")
	if err != nil {
		return nil, err
	}
	return gen.GetFeedTimer200JSONResponse{Breast: breast, Pump: pump}, nil
}

// StartFeedTimer implements POST /api/feeds/timer.
func (d Deps) StartFeedTimer(ctx context.Context, req gen.StartFeedTimerRequestObject) (gen.StartFeedTimerResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("StartFeedTimer")
	}
	body := req.Body

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: body.BabyId}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.StartFeedTimer404JSONResponse(unknownBabyErr()), nil
		}
		return nil, err
	}

	start := d.Now()
	if body.StartTime != nil {
		start = *body.StartTime
	}
	side := "left"
	if body.Kind == gen.StartFeedTimerKindPump {
		side = "both"
	}
	if body.Side != nil {
		side = string(*body.Side)
	}

	id, err := d.Q.CreateFeedTimer(ctx, dbgen.CreateFeedTimerParams{
		FamilyID:      fam.FamilyID,
		BabyID:        body.BabyId,
		CaretakerID:   fam.UserID,
		Kind:          string(body.Kind),
		StartTime:     ts(start),
		RunningSide:   &side,
		SideStartedAt: ts(start),
	})
	if err != nil {
		// feed_timer_one_per_baby_kind: the only pre-check is the index.
		if db.IsUniqueViolation(err) {
			return gen.StartFeedTimer409JSONResponse(alreadyActiveFeedTimer()), nil
		}
		return nil, err
	}
	created, err := d.Q.GetFeedTimer(ctx, dbgen.GetFeedTimerParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.StartFeedTimer201JSONResponse(serFeedTimer(created)), nil
}

// SetFeedTimerSide implements POST /api/feeds/timer/{id}/side: switch or
// pause. The running stretch is banked first, on the server's clock.
func (d Deps) SetFeedTimerSide(ctx context.Context, req gen.SetFeedTimerSideRequestObject) (gen.SetFeedTimerSideResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetFeedTimerSide")
	}
	timer, err := d.Q.GetFeedTimer(ctx, dbgen.GetFeedTimerParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.SetFeedTimerSide404JSONResponse(noFeedTimer()), nil
		}
		return nil, err
	}
	if timer.Kind == "pump" && req.Body.Side == nil {
		return gen.SetFeedTimerSide400JSONResponse{Error: "A pump timer cannot be paused", Code: "VALIDATION"}, nil
	}

	now := d.Now()
	left, right := bankedSeconds(timer.RunningSide, timer.SideStartedAt, timer.LeftSec, timer.RightSec, now)
	var side *string
	var startedAt pgtype.Timestamptz
	if req.Body.Side != nil {
		v := string(*req.Body.Side)
		side = &v
		startedAt = ts(now)
	}
	if _, err := d.Q.SetFeedTimerSides(ctx, dbgen.SetFeedTimerSidesParams{
		FamilyID:      fam.FamilyID,
		ID:            req.Id,
		RunningSide:   side,
		SideStartedAt: startedAt,
		LeftSec:       left,
		RightSec:      right,
	}); err != nil {
		return nil, err
	}
	updated, err := d.Q.GetFeedTimer(ctx, dbgen.GetFeedTimerParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.SetFeedTimerSide200JSONResponse(serFeedTimer(updated)), nil
}

// StopFeedTimer implements POST /api/feeds/timer/{id}/stop — see this
// file's doc comment for why it is one transaction.
func (d Deps) StopFeedTimer(ctx context.Context, req gen.StopFeedTimerRequestObject) (gen.StopFeedTimerResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	body := req.Body
	if body == nil {
		body = &gen.StopFeedTimer{}
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	timer, err := qtx.GetFeedTimer(ctx, dbgen.GetFeedTimerParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.StopFeedTimer404JSONResponse(noFeedTimer()), nil
		}
		return nil, err
	}

	now := d.Now()
	leftSec, rightSec := bankedSeconds(timer.RunningSide, timer.SideStartedAt, timer.LeftSec, timer.RightSec, now)
	leftMin, rightMin := minutesFromSeconds(leftSec), minutesFromSeconds(rightSec)
	if body.LeftMin != nil {
		leftMin = *body.LeftMin
	}
	if body.RightMin != nil {
		rightMin = *body.RightMin
	}
	logged := timer.StartTime
	if body.Time != nil {
		logged = ts(*body.Time)
	}

	out := gen.FeedTimerStopped{Kind: gen.FeedTimerStoppedKind(timer.Kind)}
	switch timer.Kind {
	case "pump":
		// One clock: whatever it banked is the duration, and the side is
		// the one chosen at start.
		duration := minutesFromSeconds(leftSec + rightSec)
		if body.DurationMin != nil {
			duration = *body.DurationMin
		}
		side := "both"
		if timer.RunningSide != nil {
			side = *timer.RunningSide
		}
		if body.Side != nil {
			side = string(*body.Side)
		}
		id, err := qtx.CreatePump(ctx, dbgen.CreatePumpParams{
			FamilyID:    fam.FamilyID,
			BabyID:      timer.BabyID,
			CaretakerID: fam.UserID,
			Time:        logged,
			Side:        &side,
			AmountMl:    body.AmountMl,
			DurationMin: &duration,
			Notes:       body.Notes,
		})
		if err != nil {
			return nil, err
		}
		row, err := qtx.GetPump(ctx, dbgen.GetPumpParams{FamilyID: fam.FamilyID, ID: id})
		if err != nil {
			return nil, err
		}
		pump := serPump(row)
		out.Pump = &pump
	default:
		side := "left"
		switch {
		case leftMin > 0 && rightMin > 0:
			side = "both"
		case rightMin > 0:
			side = "right"
		}
		duration := leftMin + rightMin
		id, err := qtx.CreateFeed(ctx, dbgen.CreateFeedParams{
			FamilyID:    fam.FamilyID,
			BabyID:      timer.BabyID,
			CaretakerID: fam.UserID,
			Time:        logged,
			Type:        "breast",
			Side:        &side,
			DurationMin: &duration,
			LeftMin:     &leftMin,
			RightMin:    &rightMin,
			Notes:       body.Notes,
		})
		if err != nil {
			return nil, err
		}
		row, err := qtx.GetFeed(ctx, dbgen.GetFeedParams{FamilyID: fam.FamilyID, ID: id})
		if err != nil {
			return nil, err
		}
		feed := serFeed(row)
		out.Feed = &feed
	}

	n, err := qtx.DeleteFeedTimer(ctx, dbgen.DeleteFeedTimerParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		// A concurrent stop got there first; the deferred rollback drops
		// the row this transaction inserted.
		return gen.StopFeedTimer404JSONResponse(noFeedTimer()), nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return gen.StopFeedTimer201JSONResponse(out), nil
}

// DiscardFeedTimer implements DELETE /api/feeds/timer/{id}.
func (d Deps) DiscardFeedTimer(ctx context.Context, req gen.DiscardFeedTimerRequestObject) (gen.DiscardFeedTimerResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteFeedTimer(ctx, dbgen.DeleteFeedTimerParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DiscardFeedTimer404JSONResponse(noFeedTimer()), nil
	}
	return gen.DiscardFeedTimer200JSONResponse{Ok: gen.OkOkTrue}, nil
}
