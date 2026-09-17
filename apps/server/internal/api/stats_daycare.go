package api

import (
	"math"

	"github.com/refsdal/pjokk/server/internal/api/gen"
)

// Barnehage days against home days (issue #111): the question a family asks
// a month in — is the single midday nap pushing bedtime, are nights worse
// after barnehage? GetStats collects one daySleep per COMPLETED local day
// (today is left out: its nap and its night are not over) and this file
// averages the two kinds. Pure, so the arithmetic is tested without a
// database.

const dayMin = 24 * 60

// splitMinDays is how many days of EACH kind the window must hold before
// the split is shown at all. One day is an anecdote, and a row that says
// "home days: bedtime 21:40" from a single Saturday would be read as a
// pattern.
const splitMinDays = 2

// daySleep is one completed local day.
type daySleep struct {
	daycare bool
	// napMs is the day's daytime sleep: each non-night session counted
	// whole against the day it STARTED on, as avgNapMin counts them.
	napMs int64
	// The night that followed (night D = local noon of D to noon of D+1).
	hasNight bool
	nightMs  int64
	// bedtimeMs is the night's first session start, in ms after the local
	// midnight that BEGAN day D — so it runs 12 h to 36 h, and bedtimes
	// either side of midnight average on one line.
	bedtimeMs int64
}

func dayGroup(days []daySleep) gen.StatsDayGroup {
	g := gen.StatsDayGroup{Days: int32(len(days))}
	if len(days) == 0 {
		return g
	}
	var nap, night, bed int64
	var nights int64
	for _, d := range days {
		nap += d.napMs
		if d.hasNight {
			nights++
			night += d.nightMs
			bed += d.bedtimeMs
		}
	}
	g.AvgNapMin = int32(math.Round(float64(nap) / float64(len(days)) / 60_000))
	if nights > 0 {
		n := int32(math.Round(float64(night) / float64(nights) / 60_000))
		b := int32(math.Round(float64(bed)/float64(nights)/60_000)) % dayMin
		g.AvgNightSleepMin, g.AvgBedtimeMin = &n, &b
	}
	return g
}

// daycareSplit averages the two kinds of day, or returns nil when the
// window does not hold enough of both to say anything.
func daycareSplit(days []daySleep) *gen.StatsDaycareSplit {
	var at, home []daySleep
	for _, d := range days {
		if d.daycare {
			at = append(at, d)
		} else {
			home = append(home, d)
		}
	}
	if len(at) < splitMinDays || len(home) < splitMinDays {
		return nil
	}
	return &gen.StatsDaycareSplit{Daycare: dayGroup(at), Home: dayGroup(home)}
}
