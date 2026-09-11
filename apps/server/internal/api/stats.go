package api

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

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
// return 402`. That gate is gone: every window from 1 to 90 days (the
// spec's days query param bounds) is free, mirroring the same de-gating
// this Go port already did for
// calendar/contacts creation.
//
// # Query reuse, not duplication
//
// FeedsInRange/DiapersInRange/SleepsInRange (queries/summary.sql) and
// ListMeasurements (queries/other_logs.sql) already do exactly what this
// route needs — the same per-baby-range/latest-N reads GetSummary and
// ListMeasurements use — so this file adds NO new sqlc queries, the same
// way GetSummary (summary.go) reuses sleep.sql's ActiveSleep and
// play.sql's ActivePlay instead of duplicating them.

// GetStats implements GET /api/stats. {days:[{date,sleepMin,
// intakeMl,feeds,diapers}], avgSleepMin, avgIntakeMl, avgFeeds, avgDiapers,
// weight:{value,time,prevValue,prevTime}|null} / 404 unknown baby.
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
			return gen.GetStats404JSONResponse(unknownBabyErr()), nil
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

	fromTS := ts(time.UnixMilli(rangeFrom))
	toTS := ts(time.UnixMilli(rangeTo))
	// Sleep is read from noon of the day BEFORE the window (issue #50): the
	// night that ended this morning began yesterday afternoon, and a
	// one-day window must still be able to answer "how long was the
	// longest stretch last night?". The day buckets clip to rangeFrom
	// below, so the extra sessions never leak into a day outside the window.
	sleepFromTS := ts(time.UnixMilli(rangeFrom - summaryDayMs/2))

	feeds, err := d.Q.FeedsInRange(ctx, dbgen.FeedsInRangeParams{FamilyID: fam.FamilyID, BabyID: babyID, FromTs: fromTS, ToTs: toTS})
	if err != nil {
		return nil, err
	}
	diapers, err := d.Q.DiapersInRange(ctx, dbgen.DiapersInRangeParams{FamilyID: fam.FamilyID, BabyID: babyID, FromTs: fromTS, ToTs: toTS})
	if err != nil {
		return nil, err
	}
	sleeps, err := d.Q.SleepsInRange(ctx, dbgen.SleepsInRangeParams{FamilyID: fam.FamilyID, BabyID: babyID, FromTs: sleepFromTS, ToTs: toTS})
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
		sleepMs      int64
		nightSleepMs int64
		intakeMl     int32
		feeds        int32
		bottle       int32
		breast       int32
		solids       int32
		diapers      int32
	}
	buckets := make(map[int64]*bucket, days)
	for i := startIdx; i <= todayIdx; i++ {
		buckets[i] = &bucket{}
	}

	// TS lines 64-70.
	for _, f := range feeds {
		if b, ok := buckets[dayIndex(f.Time.Time.UnixMilli())]; ok {
			b.feeds++
			switch f.Type {
			case "bottle":
				b.bottle++
				if f.AmountMl != nil {
					b.intakeMl += *f.AmountMl
				}
			case "breast":
				b.breast++
			case "solids":
				b.solids++
			}
		}
	}
	// TS lines 71-74.
	for _, dg := range diapers {
		if b, ok := buckets[dayIndex(dg.Time.Time.UnixMilli())]; ok {
			b.diapers++
		}
	}
	// Nights (issue #50): a `night` session belongs to the night it STARTED
	// in, night D = [noon of local day D, noon of D+1). One entry per day
	// of the window plus the night before it (see sleepFromTS); the noon
	// shift is the same fixed-offset arithmetic as the day buckets (so,
	// like them, it does not follow a DST change inside the window — see
	// the StatsNight schema description).
	type night struct {
		longestMs int64
		sessions  int32
	}
	nights := make(map[int64]*night, days+1)
	for i := startIdx - 1; i <= todayIdx; i++ {
		nights[i] = &night{}
	}
	nightIndex := func(utcMs int64) int64 { return dayIndex(utcMs - summaryDayMs/2) }

	// Typical nap: the mean length of ONE non-night session. Deliberately
	// NOT computed from the day buckets above — those cut a session at
	// local midnight, which is right for "sleep per day" and wrong for
	// "how long is a nap". A nap is counted once, whole, against the day
	// it STARTED in, so the guards below are its own: sessions starting
	// before rangeFrom (SleepsInRange overlaps, so it returns them) and
	// running sessions (no length yet) are both skipped.
	var napMs int64
	var napCount int64

	// TS lines 76-89: split each session across the local midnights it
	// crosses. Active sessions (EndTime not Valid) count up to now.
	for _, sl := range sleeps {
		isNight := sl.Type != nil && *sl.Type == "night"
		if !isNight && sl.EndTime.Valid {
			if start := sl.StartTime.Time.UnixMilli(); start >= rangeFrom {
				napMs += sl.EndTime.Time.UnixMilli() - start
				napCount++
			}
		}
		if isNight {
			if n, ok := nights[nightIndex(sl.StartTime.Time.UnixMilli())]; ok {
				end := now
				if sl.EndTime.Valid && sl.EndTime.Time.UnixMilli() < end {
					end = sl.EndTime.Time.UnixMilli()
				}
				n.sessions++
				if d := end - sl.StartTime.Time.UnixMilli(); d > n.longestMs {
					n.longestMs = d
				}
			}
		}
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
				if isNight {
					b.nightSleepMs += chunkEnd - cur
				}
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
	statsNights := make([]gen.StatsNight, 0, todayIdx-startIdx+2)
	for i := startIdx - 1; i <= todayIdx; i++ {
		sn := gen.StatsNight{Date: time.UnixMilli(i * summaryDayMs).UTC().Format("2006-01-02")}
		if n := nights[i]; n.sessions > 0 {
			longest := int32(roundDiv(n.longestMs, 60_000))
			wakings := n.sessions - 1
			sn.LongestStretchMin = &longest
			sn.Wakings = &wakings
		}
		statsNights = append(statsNights, sn)
	}
	var sumSleep, sumNight, sumIntake, sumFeeds, sumBottle, sumBreast, sumSolids, sumDiapers int64
	for i := startIdx; i <= todayIdx; i++ {
		b := buckets[i]
		sleepMin := int32(roundDiv(b.sleepMs, 60_000))
		nightMin := int32(roundDiv(b.nightSleepMs, 60_000))
		date := time.UnixMilli(i * summaryDayMs).UTC().Format("2006-01-02")
		statsDays = append(statsDays, gen.StatsDay{
			Date:          date,
			SleepMin:      sleepMin,
			NightSleepMin: nightMin,
			IntakeMl:      b.intakeMl,
			Feeds:         b.feeds,
			FeedsByType:   gen.StatsFeedsByType{Bottle: float64(b.bottle), Breast: float64(b.breast), Solids: float64(b.solids)},
			Diapers:       b.diapers,
		})
		sumSleep += int64(sleepMin)
		sumNight += int64(nightMin)
		sumIntake += int64(b.intakeMl)
		sumFeeds += int64(b.feeds)
		sumBottle += int64(b.bottle)
		sumBreast += int64(b.breast)
		sumSolids += int64(b.solids)
		sumDiapers += int64(b.diapers)
	}

	// TS lines 99-111: avgSleepMin/avgIntakeMl round to the nearest
	// integer; avgFeeds/avgDiapers round to one decimal
	// (Math.round(x*10)/10).
	daysF := float64(days)
	avgSleepMin := int32(math.Round(float64(sumSleep) / daysF))
	avgNightSleepMin := int32(math.Round(float64(sumNight) / daysF))
	avgIntakeMl := int32(math.Round(float64(sumIntake) / daysF))
	avg1 := func(sum int64) float64 { return math.Round(float64(sum)/daysF*10) / 10 }
	var avgNapMin int32
	if napCount > 0 {
		avgNapMin = int32(math.Round(float64(napMs) / float64(napCount) / 60_000))
	}
	avgNaps := avg1(napCount)
	avgFeeds := avg1(sumFeeds)
	avgDiapers := avg1(sumDiapers)

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
		Days:             statsDays,
		Nights:           statsNights,
		AvgSleepMin:      avgSleepMin,
		AvgNightSleepMin: avgNightSleepMin,
		AvgNapMin:        avgNapMin,
		AvgNaps:          avgNaps,
		AvgIntakeMl:      avgIntakeMl,
		AvgFeeds:         avgFeeds,
		AvgFeedsByType:   gen.StatsFeedsByType{Bottle: avg1(sumBottle), Breast: avg1(sumBreast), Solids: avg1(sumSolids)},
		AvgDiapers:       avgDiapers,
		Weight:           weight,
	}, nil
}
