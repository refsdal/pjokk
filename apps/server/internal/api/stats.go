package api

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/stats.ts's GET /api/stats EXACTLY —
// the day-bucketing and midnight-splitting math below is the same
// algorithm as the TS route, line for line, not reinvented. Where a block
// mirrors a specific TS line range that range is cited in the comment
// above it.
//
// # The removed premium gate
//
// TS: `if (q.days > 7 && !canUse({ plan: c.var.plan }, "statsMonth"))
// return 402`. This task's route contract removes that gate entirely (see
// this task's brief: "statsMonth gate REMOVED — days up to 90 free") —
// every window from 1 to 90 days (the spec's days query param bounds) is
// free, mirroring the same de-gating this Go port already did for
// calendar/contacts creation (Task 16).
//
// # Query reuse, not duplication
//
// FeedsInRange/DiapersInRange/SleepsInRange (queries/summary.sql) and
// ListMeasurements (queries/other_logs.sql) already do exactly what this
// route needs — the same per-baby-range/latest-N reads GetSummary and
// ListMeasurements use — so this file adds NO new sqlc queries, the same
// way GetSummary (summary.go) reuses sleep.sql's ActiveSleep and
// play.sql's ActivePlay instead of duplicating them.

// GetStats implements GET /api/stats. REF: "{days:[{date,sleepMin,
// intakeMl,feeds,diapers}], avgSleepMin, avgIntakeMl, avgFeeds, avgDiapers,
// weight:{value,time,prevValue,prevTime}|null} / 404 unknown baby".
func (d Deps) GetStats(ctx context.Context, req gen.GetStatsRequestObject) (gen.GetStatsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	babyID := req.Params.BabyId

	// TS lines 9-16 (statsQuery): days defaults to 7 (1..90), tz defaults
	// to 0 (-840..840) — both already enforced by kin-openapi's spec
	// validation against this operation's min/max/default, so no
	// clamping is needed here; a request that violates either bound never
	// reaches this handler.
	days := 7
	if req.Params.Days != nil {
		days = *req.Params.Days
	}
	var tz int64
	if req.Params.Tz != nil {
		tz = int64(*req.Params.Tz)
	}

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: babyID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.GetStats404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	// TS lines 41-47: tzMs, dayIndex, todayIdx, startIdx, rangeFrom,
	// rangeTo — identical to summary.go's floorDivInt64-based day-index
	// math (see that file's header), just parameterised by `days` instead
	// of always being "today".
	tzMs := tz * 60_000
	now := d.Now().UnixMilli()
	dayIndex := func(utcMs int64) int64 { return floorDivInt64(utcMs-tzMs, summaryDayMs) }
	todayIdx := dayIndex(now)
	startIdx := todayIdx - int64(days-1)
	rangeFrom := startIdx*summaryDayMs + tzMs
	rangeTo := (todayIdx+1)*summaryDayMs + tzMs

	fromTS := pgtype.Timestamptz{Time: time.UnixMilli(rangeFrom), Valid: true}
	toTS := pgtype.Timestamptz{Time: time.UnixMilli(rangeTo), Valid: true}

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
	// TS: `fam.measurement.list({ babyId: q.babyId, limit: 100 })` — the
	// weight computed below reads only the first two type==="weight" rows
	// out of this newest-first-100 list, matching TS exactly (ListMeasurements
	// orders `time DESC, id DESC`, same as scoped.ts's listMeasurements).
	measurements, err := d.Q.ListMeasurements(ctx, dbgen.ListMeasurementsParams{FamilyID: fam.FamilyID, BabyID: &babyID, Lim: 100})
	if err != nil {
		return nil, err
	}

	// TS lines 56-62: one bucket per local day in [startIdx, todayIdx].
	type bucket struct {
		sleepMs  int64
		intakeMl int32
		feeds    int32
		diapers  int32
	}
	buckets := make(map[int64]*bucket, days)
	for i := startIdx; i <= todayIdx; i++ {
		buckets[i] = &bucket{}
	}

	// TS lines 64-70.
	for _, f := range feeds {
		if b, ok := buckets[dayIndex(f.Time.Time.UnixMilli())]; ok {
			b.feeds++
			if f.Type == "bottle" {
				if f.AmountMl != nil {
					b.intakeMl += *f.AmountMl
				}
			}
		}
	}
	// TS lines 71-74.
	for _, dg := range diapers {
		if b, ok := buckets[dayIndex(dg.Time.Time.UnixMilli())]; ok {
			b.diapers++
		}
	}
	// TS lines 76-89: split each session across the local midnights it
	// crosses. Active sessions (EndTime not Valid) count up to now.
	for _, sl := range sleeps {
		cur := sl.StartTime.Time.UnixMilli()
		if cur < rangeFrom {
			cur = rangeFrom
		}
		end := now
		if sl.EndTime.Valid {
			if et := sl.EndTime.Time.UnixMilli(); et < end {
				end = et
			}
		}
		if rangeTo < end {
			end = rangeTo
		}
		if now < end {
			end = now
		}
		for cur < end {
			idx := dayIndex(cur)
			dayEnd := (idx+1)*summaryDayMs + tzMs
			chunkEnd := end
			if dayEnd < chunkEnd {
				chunkEnd = dayEnd
			}
			if b, ok := buckets[idx]; ok {
				b.sleepMs += chunkEnd - cur
			}
			cur = chunkEnd
		}
	}

	// TS lines 91-97: date is idx*DAY formatted in UTC — NOT idx*DAY+tzMs.
	// This is deliberate, not a bug: idx already folded tz into the day
	// boundary (dayIndex subtracts tzMs before flooring), so re-expanding
	// idx*DAY as a bare UTC instant reproduces the correct calendar-date
	// label without double-applying the offset.
	statsDays := make([]gen.StatsDay, 0, todayIdx-startIdx+1)
	var sumSleep, sumIntake, sumFeeds, sumDiapers int64
	for i := startIdx; i <= todayIdx; i++ {
		b := buckets[i]
		sleepMin := int32(roundDiv(b.sleepMs, 60_000))
		date := time.UnixMilli(i * summaryDayMs).UTC().Format("2006-01-02")
		statsDays = append(statsDays, gen.StatsDay{
			Date:     date,
			SleepMin: sleepMin,
			IntakeMl: b.intakeMl,
			Feeds:    b.feeds,
			Diapers:  b.diapers,
		})
		sumSleep += int64(sleepMin)
		sumIntake += int64(b.intakeMl)
		sumFeeds += int64(b.feeds)
		sumDiapers += int64(b.diapers)
	}

	// TS lines 99-111: avgSleepMin/avgIntakeMl round to the nearest
	// integer; avgFeeds/avgDiapers round to one decimal
	// (Math.round(x*10)/10).
	daysF := float64(days)
	avgSleepMin := int32(math.Round(float64(sumSleep) / daysF))
	avgIntakeMl := int32(math.Round(float64(sumIntake) / daysF))
	avgFeeds := math.Round(float64(sumFeeds)/daysF*10) / 10
	avgDiapers := math.Round(float64(sumDiapers)/daysF*10) / 10

	// TS lines 102-119: latest + predecessor `type === "weight"`
	// measurement, in the newest-first order ListMeasurements already
	// returns.
	var weight *gen.StatsWeight
	var latest, prev *dbgen.ListMeasurementsRow
	for i := range measurements {
		if measurements[i].Type != "weight" {
			continue
		}
		if latest == nil {
			latest = &measurements[i]
		} else {
			prev = &measurements[i]
			break
		}
	}
	if latest != nil {
		w := gen.StatsWeight{Value: latest.Value, Time: latest.Time.Time}
		if prev != nil {
			pv := prev.Value
			w.PrevValue = &pv
			pt := prev.Time.Time
			w.PrevTime = &pt
		}
		weight = &w
	}

	return gen.GetStats200JSONResponse{
		Days:        statsDays,
		AvgSleepMin: avgSleepMin,
		AvgIntakeMl: avgIntakeMl,
		AvgFeeds:    avgFeeds,
		AvgDiapers:  avgDiapers,
		Weight:      weight,
	}, nil
}
