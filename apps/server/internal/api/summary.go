package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file implements GET /api/summary (REF §A1; ports
// apps/api/src/routes/sleep.ts's summary route in full — the route lives
// alongside sleep in the TS source, but gets its own file here since it
// touches feeds/diapers/sleep/play, not just sleep).
//
// lastFeed/lastDiaper/activeSleep/lastSleep/activePlay are each a
// single-row read reusing the SAME sqlc queries feeds.go/diapers.go/
// sleep.go/play.go already have (ListFeeds/ListDiapers with lim=1,
// ActiveSleep, ListSleeps with lim=1, ActivePlay) rather than duplicating
// them.
//
// The `today` block's day-boundary math is ported EXACTLY from the TS
// route, not reinvented — it is easy to get subtly wrong. The window is the
// CALLER's local day (via the tz query param: minutes UTC-minus-local, the
// same sign convention as JS's Date.getTimezoneOffset()), not the server's:
//
//	tzMs      = tz * 60_000
//	dayIdx    = floor((now - tzMs) / DAY)
//	rangeFrom = dayIdx * DAY + tzMs
//	rangeTo   = (dayIdx + 1) * DAY + tzMs

// summaryDayMs mirrors apps/api/src/routes/sleep.ts's DAY constant
// (86_400_000 ms in a day).
const summaryDayMs = 86_400_000

// floorDivInt64 is integer division that rounds toward negative infinity
// (JS's Math.floor(a/b)), unlike Go's "/" which truncates toward zero (like
// C). The two only disagree when a and b have different signs, which never
// happens for `now - tzMs` in practice (now is a large positive epoch-ms
// value, tzMs maxes out at 840*60_000) — but this keeps the math correct on
// that point rather than merely "correct because the input happens not to
// trigger it".
func floorDivInt64(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// GetSummary implements GET /api/summary. REF: "{lastFeed, lastDiaper,
// activeSleep, lastSleep, activePlay, today} / 404 unknown baby".
func (d Deps) GetSummary(ctx context.Context, req gen.GetSummaryRequestObject) (gen.GetSummaryResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	babyID := req.Params.BabyId

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: babyID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.GetSummary404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	var tz int64
	if req.Params.Tz != nil {
		tz = int64(*req.Params.Tz)
	}

	now := d.Now().UnixMilli()
	tzMs := tz * 60_000
	dayIdx := floorDivInt64(now-tzMs, summaryDayMs)
	rangeFrom := dayIdx*summaryDayMs + tzMs
	rangeTo := (dayIdx+1)*summaryDayMs + tzMs

	fromTS := pgtype.Timestamptz{Time: time.UnixMilli(rangeFrom), Valid: true}
	toTS := pgtype.Timestamptz{Time: time.UnixMilli(rangeTo), Valid: true}

	lastFeeds, err := d.Q.ListFeeds(ctx, dbgen.ListFeedsParams{FamilyID: fam.FamilyID, BabyID: &babyID, Lim: 1})
	if err != nil {
		return nil, err
	}
	var lastFeed *gen.FeedLog
	if len(lastFeeds) > 0 {
		v := serFeedListRow(lastFeeds[0])
		lastFeed = &v
	}

	// The newest TEMPERATURE, not the newest measurement — its own query for
	// exactly that reason (see summary.sql). Backs the Home temperature card.
	lastTemps, err := d.Q.LastMeasurementOfType(ctx, dbgen.LastMeasurementOfTypeParams{
		FamilyID: fam.FamilyID,
		BabyID:   babyID,
		Type:     "temperature",
	})
	if err != nil {
		return nil, err
	}
	var lastTemperature *gen.MeasurementLog
	if len(lastTemps) > 0 {
		r := lastTemps[0]
		v := serMeasurement(r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Time, r.Type, r.Value, r.Notes)
		lastTemperature = &v
	}

	lastDiapers, err := d.Q.ListDiapers(ctx, dbgen.ListDiapersParams{FamilyID: fam.FamilyID, BabyID: &babyID, Lim: 1})
	if err != nil {
		return nil, err
	}
	var lastDiaper *gen.DiaperLog
	if len(lastDiapers) > 0 {
		v := serDiaperListRow(lastDiapers[0])
		lastDiaper = &v
	}

	var activeSleep *gen.SleepLog
	if active, err := d.Q.ActiveSleep(ctx, dbgen.ActiveSleepParams{FamilyID: fam.FamilyID, BabyID: &babyID}); err == nil {
		v := serActiveSleepRow(active)
		activeSleep = &v
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	lastSleeps, err := d.Q.ListSleeps(ctx, dbgen.ListSleepsParams{FamilyID: fam.FamilyID, BabyID: &babyID, Lim: 1})
	if err != nil {
		return nil, err
	}
	var lastSleep *gen.SleepLog
	if len(lastSleeps) > 0 {
		v := serSleepListRow(lastSleeps[0])
		lastSleep = &v
	}

	var activePlay *gen.PlayLog
	if play, err := d.Q.ActivePlay(ctx, dbgen.ActivePlayParams{FamilyID: fam.FamilyID, BabyID: &babyID}); err == nil {
		v := serActivePlayRow(play)
		activePlay = &v
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	feeds, err := d.Q.FeedsInRange(ctx, dbgen.FeedsInRangeParams{FamilyID: fam.FamilyID, BabyID: babyID, FromTs: fromTS, ToTs: toTS})
	if err != nil {
		return nil, err
	}
	diapers, err := d.Q.DiapersInRange(ctx, dbgen.DiapersInRangeParams{FamilyID: fam.FamilyID, BabyID: babyID, FromTs: fromTS, ToTs: toTS})
	if err != nil {
		return nil, err
	}
	sleeps, err := d.Q.SleepsInRange(ctx, dbgen.SleepsInRangeParams{FamilyID: fam.FamilyID, BabyID: babyID, FromTs: fromTS, ToTs: toTS})
	if err != nil {
		return nil, err
	}

	var today struct {
		Both     int32
		Dirty    int32
		Feeds    int32
		IntakeMl int32
		SleepMin int32
		SolidsG  int32
		Wet      int32
	}
	for _, f := range feeds {
		today.Feeds++
		amount := int32(0)
		if f.AmountMl != nil {
			amount = *f.AmountMl
		}
		switch f.Type {
		case "bottle":
			today.IntakeMl += amount
		case "solids":
			today.SolidsG += amount
		}
	}
	for _, dg := range diapers {
		switch dg.Type {
		case "wet":
			today.Wet++
		case "dirty":
			today.Dirty++
		default: // "both"
			today.Both++
		}
	}
	// Sleep minutes inside today's window; active sessions count up to now.
	for _, sl := range sleeps {
		from := sl.StartTime.Time.UnixMilli()
		if from < rangeFrom {
			from = rangeFrom
		}
		to := now
		if sl.EndTime.Valid && sl.EndTime.Time.UnixMilli() < to {
			to = sl.EndTime.Time.UnixMilli()
		}
		if rangeTo < to {
			to = rangeTo
		}
		if to > from {
			today.SleepMin += int32(roundDiv(to-from, 60_000))
		}
	}

	return gen.GetSummary200JSONResponse{
		LastFeed:        lastFeed,
		LastDiaper:      lastDiaper,
		ActiveSleep:     activeSleep,
		LastSleep:       lastSleep,
		ActivePlay:      activePlay,
		LastTemperature: lastTemperature,
		Today: struct {
			Both     int32 `json:"both"`
			Dirty    int32 `json:"dirty"`
			Feeds    int32 `json:"feeds"`
			IntakeMl int32 `json:"intakeMl"`
			SleepMin int32 `json:"sleepMin"`
			SolidsG  int32 `json:"solidsG"`
			Wet      int32 `json:"wet"`
		}{
			Both:     today.Both,
			Dirty:    today.Dirty,
			Feeds:    today.Feeds,
			IntakeMl: today.IntakeMl,
			SleepMin: today.SleepMin,
			SolidsG:  today.SolidsG,
			Wet:      today.Wet,
		},
	}, nil
}

// roundDiv rounds a/b to the nearest integer, matching JS's Math.round for
// the positive values sleep-minute durations always are here (to > from is
// checked before this is called).
func roundDiv(a, b int64) int64 {
	return (a + b/2) / b
}
