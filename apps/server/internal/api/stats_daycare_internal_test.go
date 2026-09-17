package api

import "testing"

// daycareSplit's arithmetic (issue #111), without a database.

const hourMs = int64(3_600_000)

func day(daycare bool, napH float64, nightH float64, bedtimeH float64) daySleep {
	d := daySleep{daycare: daycare, napMs: int64(napH * float64(hourMs))}
	if nightH > 0 {
		d.hasNight, d.nightMs, d.bedtimeMs = true, int64(nightH*float64(hourMs)), int64(bedtimeH*float64(hourMs))
	}
	return d
}

func TestDaycareSplitNeedsTwoDaysOfEachKind(t *testing.T) {
	week := []daySleep{day(true, 1, 11, 19), day(true, 1, 11, 19), day(true, 1, 11, 19), day(false, 2, 11, 19.5)}
	if got := daycareSplit(week); got != nil {
		t.Errorf("one home day gave a split %+v, want nil: one day is an anecdote", got)
	}
	if got := daycareSplit(append(week, day(false, 2, 11, 19.5))); got == nil {
		t.Errorf("two of each gave nil, want a split")
	}
	if got := daycareSplit(nil); got != nil {
		t.Errorf("no days gave %+v, want nil", got)
	}
}

func TestDaycareSplitAverages(t *testing.T) {
	got := daycareSplit([]daySleep{
		day(true, 1, 11, 18.75), day(true, 1.5, 10, 19), day(true, 0, 0, 0), // a barnehage day with no nap and no night logged
		day(false, 2, 11.5, 19.25), day(false, 2.25, 11, 19.5),
	})
	if got == nil {
		t.Fatal("split = nil")
	}
	if got.Daycare.Days != 3 || got.Home.Days != 2 {
		t.Errorf("days = %d / %d, want 3 / 2", got.Daycare.Days, got.Home.Days)
	}
	// The no-nap day counts towards the nap mean: (60 + 90 + 0) / 3.
	if got.Daycare.AvgNapMin != 50 {
		t.Errorf("barnehage nap = %d, want 50", got.Daycare.AvgNapMin)
	}
	// …but a day with no night logged does not drag the night figures down.
	if got.Daycare.AvgNightSleepMin == nil || *got.Daycare.AvgNightSleepMin != 630 {
		t.Errorf("barnehage night = %v, want 630", got.Daycare.AvgNightSleepMin)
	}
	if got.Daycare.AvgBedtimeMin == nil || *got.Daycare.AvgBedtimeMin != 18*60+53 {
		t.Errorf("barnehage bedtime = %v, want 18:53", got.Daycare.AvgBedtimeMin)
	}
	if *got.Home.AvgBedtimeMin != 19*60+23 || got.Home.AvgNapMin != 128 {
		t.Errorf("home = nap %d, bedtime %d, want 128 and 19:23", got.Home.AvgNapMin, *got.Home.AvgBedtimeMin)
	}
}

// Bedtimes either side of midnight average to midnight, not noon: they are
// measured from the midnight that began the day, so 23:50 is 23.83 h and
// 00:10 is 24.17 h.
func TestDaycareSplitBedtimeAcrossMidnight(t *testing.T) {
	got := daycareSplit([]daySleep{
		day(true, 1, 8, 23.0+50.0/60), day(true, 1, 8, 24.0+10.0/60),
		day(false, 1, 8, 20), day(false, 1, 8, 20),
	})
	if got == nil || got.Daycare.AvgBedtimeMin == nil || *got.Daycare.AvgBedtimeMin != 0 {
		t.Fatalf("bedtime = %v, want 0 (midnight)", got)
	}
	// A group with no night at all has no night figures.
	none := daycareSplit([]daySleep{day(true, 1, 0, 0), day(true, 1, 0, 0), day(false, 1, 8, 20), day(false, 1, 8, 20)})
	if none.Daycare.AvgNightSleepMin != nil || none.Daycare.AvgBedtimeMin != nil {
		t.Errorf("a group with no nights = %+v, want nil night figures", none.Daycare)
	}
}
