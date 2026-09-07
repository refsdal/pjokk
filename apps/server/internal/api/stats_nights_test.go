package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #50: the night/day split, the longest night stretch, night wakings
// and feeds by type on GET /api/stats. Extends stats_test.go's fixed-clock
// rig; the night boundary is local noon (see the StatsNight schema).
func TestGetStatsNightSplitLongestStretchAndWakings(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// Today is 2026-01-10 (tz=0). "Last night" is the night of 2026-01-09:
	// noon the 9th to noon the 10th.
	fixedNow := time.Date(2026, 1, 10, 10, 0, 0, 0, time.UTC)
	a.SetNow(fixedNow)
	day9 := time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC)

	sleep := func(start, end time.Time, typ string) {
		t.Helper()
		body := map[string]any{"babyId": babyID, "startTime": start.Format(time.RFC3339), "endTime": end.Format(time.RFC3339)}
		if typ != "" {
			body["type"] = typ
		}
		if res := a.Do(http.MethodPost, "/api/sleep", cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("create sleep: %d %s", res.Status, res.Raw)
		}
	}
	// Night of the 9th: 20:00–00:30 (4 h 30), resettle 01:00–06:00 (5 h),
	// then a 06:30–07:00 top-up. Three sessions → 2 wakings, longest 300.
	sleep(day9.Add(20*time.Hour), day9.Add(24*time.Hour+30*time.Minute), "night")
	sleep(day9.Add(25*time.Hour), day9.Add(30*time.Hour), "night")
	sleep(day9.Add(30*time.Hour+30*time.Minute), day9.Add(31*time.Hour), "night")
	// A nap on the 9th (13:00–14:00) and an untyped one (10:00–10:30): day sleep.
	sleep(day9.Add(13*time.Hour), day9.Add(14*time.Hour), "nap")
	sleep(day9.Add(10*time.Hour), day9.Add(10*time.Hour+30*time.Minute), "")
	// The night of the 8th: one unbroken 22:00–06:00 stretch (480, 0 wakings).
	sleep(day9.Add(-2*time.Hour), day9.Add(6*time.Hour), "night")

	feed := func(at time.Time, typ string) {
		t.Helper()
		body := map[string]any{"babyId": babyID, "time": at.Format(time.RFC3339), "type": typ}
		if typ == "breast" {
			body["side"] = "left"
		}
		if res := a.Do(http.MethodPost, "/api/feeds", cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("create feed: %d %s", res.Status, res.Raw)
		}
	}
	feed(day9.Add(8*time.Hour), "bottle")
	feed(day9.Add(12*time.Hour), "breast")
	feed(day9.Add(16*time.Hour), "breast")
	feed(day9.Add(18*time.Hour), "solids")

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d %s", res.Status, res.Raw)
	}
	days, _ := res.JSON["days"].([]any)
	nights, _ := res.JSON["nights"].([]any)
	if len(days) != 7 || len(nights) != 8 {
		t.Fatalf("days/nights = %d/%d, want 7 days and 8 nights (the night before the window included)", len(days), len(nights))
	}
	d9, _ := days[5].(map[string]any)
	d10, _ := days[6].(map[string]any)
	// The 9th: 06:00 of the 8th's night (360) + nap 60 + untyped 30 +
	// 20:00–24:00 of its own night (240) = 690 total, 600 night.
	if d9["sleepMin"] != float64(690) || d9["nightSleepMin"] != float64(600) {
		t.Errorf("day 9 = %v, want sleepMin 690 nightSleepMin 600", d9)
	}
	// The 10th: 00:00–00:30 + 01:00–06:00 + 06:30–07:00 = 360, all night.
	if d10["sleepMin"] != float64(360) || d10["nightSleepMin"] != float64(360) {
		t.Errorf("day 10 = %v, want 360/360", d10)
	}
	fbt, _ := d9["feedsByType"].(map[string]any)
	if d9["feeds"] != float64(4) || fbt["bottle"] != float64(1) || fbt["breast"] != float64(2) || fbt["solids"] != float64(1) {
		t.Errorf("day 9 feeds = %v %v, want 4 = 1 bottle + 2 breast + 1 solids", d9["feeds"], fbt)
	}

	n8, _ := nights[5].(map[string]any)
	n9, _ := nights[6].(map[string]any)
	n10, _ := nights[7].(map[string]any)
	if n8["date"] != "2026-01-08" || n8["longestStretchMin"] != float64(480) || n8["wakings"] != float64(0) {
		t.Errorf("night of the 8th = %v, want 480 / 0 wakings", n8)
	}
	if n9["longestStretchMin"] != float64(300) || n9["wakings"] != float64(2) {
		t.Errorf("night of the 9th = %v, want 300 / 2 wakings", n9)
	}
	if n10["longestStretchMin"] != nil || n10["wakings"] != nil {
		t.Errorf("tonight (no session yet) = %v, want nulls", n10)
	}
	if n7, _ := nights[4].(map[string]any); n7["longestStretchMin"] != nil {
		t.Errorf("a night with no sessions = %v, want nulls", n7)
	}

	// Averages over the 7-day window.
	if res.JSON["avgNightSleepMin"] != float64(154) { // round((120+600+360)/7)
		t.Errorf("avgNightSleepMin = %v, want 154", res.JSON["avgNightSleepMin"])
	}
	avgFbt, _ := res.JSON["avgFeedsByType"].(map[string]any)
	if avgFbt["breast"] != float64(0.3) || avgFbt["bottle"] != float64(0.1) || avgFbt["solids"] != float64(0.1) {
		t.Errorf("avgFeedsByType = %v, want breast 0.3 bottle 0.1 solids 0.1", avgFbt)
	}
}

// A running night session counts up to now for the longest stretch, and
// the noon boundary puts a 23:00 bedtime and its 02:00 resettle on the
// same night.
func TestGetStatsRunningNightCountsToNow(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	fixedNow := time.Date(2026, 1, 10, 3, 0, 0, 0, time.UTC)
	a.SetNow(fixedNow)

	if res := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId": babyID, "type": "night",
		"startTime": time.Date(2026, 1, 9, 23, 0, 0, 0, time.UTC).Format(time.RFC3339),
		"endTime":   time.Date(2026, 1, 10, 1, 30, 0, 0, time.UTC).Format(time.RFC3339),
	}); res.Status != http.StatusCreated {
		t.Fatalf("create: %d %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId": babyID, "type": "night",
		"startTime": time.Date(2026, 1, 10, 2, 0, 0, 0, time.UTC).Format(time.RFC3339),
	}); res.Status != http.StatusCreated {
		t.Fatalf("start: %d %s", res.Status, res.Raw)
	}
	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=2&tz=0", cookie, nil)
	nights, _ := res.JSON["nights"].([]any)
	last, _ := nights[1].(map[string]any) // the night of the 9th (nights[0] is the 8th's)
	if last["date"] != "2026-01-09" || last["longestStretchMin"] != float64(150) || last["wakings"] != float64(1) {
		t.Errorf("night of the 9th = %v, want 150 (23:00–01:30) and 1 waking", last)
	}
	if tonight, _ := nights[2].(map[string]any); tonight["longestStretchMin"] != nil {
		t.Errorf("night of the 10th = %v, want nulls (nothing has started after noon)", tonight)
	}
}

// A one-day window still answers "last night": the night that ended this
// morning began yesterday afternoon, outside the day range.
func TestGetStatsOneDayWindowStillHasLastNight(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	a.SetNow(time.Date(2026, 1, 10, 15, 0, 0, 0, time.UTC))
	if res := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId": babyID, "type": "night",
		"startTime": time.Date(2026, 1, 9, 19, 0, 0, 0, time.UTC).Format(time.RFC3339),
		"endTime":   time.Date(2026, 1, 9, 23, 0, 0, 0, time.UTC).Format(time.RFC3339),
	}); res.Status != http.StatusCreated {
		t.Fatalf("create: %d %s", res.Status, res.Raw)
	}
	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=1&tz=0", cookie, nil)
	days, _ := res.JSON["days"].([]any)
	nights, _ := res.JSON["nights"].([]any)
	if len(days) != 1 || len(nights) != 2 {
		t.Fatalf("days/nights = %d/%d, want 1/2", len(days), len(nights))
	}
	if d, _ := days[0].(map[string]any); d["sleepMin"] != float64(0) {
		t.Errorf("today's sleep = %v, want 0 (the session was yesterday)", d["sleepMin"])
	}
	if n, _ := nights[0].(map[string]any); n["date"] != "2026-01-09" || n["longestStretchMin"] != float64(240) {
		t.Errorf("last night = %v, want the 9th with 240", n)
	}
}
