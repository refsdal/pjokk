package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// The typical-nap numbers on GET /api/stats: avgNapMin (mean duration of
// ONE nap) and avgNaps (naps per day). No TS predecessor — this is new
// behaviour, not a port.
//
// A nap is any session NOT typed `night`, matching the day/night split
// stats.go already uses for nightSleepMin (untyped sessions are the
// two-tap happy path, so they count as naps). Three rules this test
// pins down, because each of them changes the number:
//   - whole sessions, keyed by START time: unlike the day buckets, a nap
//     crossing local midnight counts ONCE, in full;
//   - a session that started before the window is excluded even though
//     SleepsInRange's overlap test returns it;
//   - a running nap has no length yet and is excluded entirely.
func TestGetStatsAverageNapLengthAndNapsPerDay(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// Today is 2026-01-10 (tz=0); a 7-day window starts 2026-01-04T00:00Z.
	fixedNow := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	a.SetNow(fixedNow)
	day9 := time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC)

	sleep := func(start time.Time, end *time.Time, typ string) {
		t.Helper()
		body := map[string]any{"babyId": babyID, "startTime": start.Format(time.RFC3339)}
		if end != nil {
			body["endTime"] = end.Format(time.RFC3339)
		}
		if typ != "" {
			body["type"] = typ
		}
		if res := a.Do(http.MethodPost, "/api/sleep", cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("create sleep: %d %s", res.Status, res.Raw)
		}
	}
	ended := func(start time.Time, d time.Duration, typ string) {
		t.Helper()
		end := start.Add(d)
		sleep(start, &end, typ)
	}

	// Counted: 60 + 30 + 60 = 150 minutes over 3 naps.
	ended(day9.Add(10*time.Hour), 60*time.Minute, "nap")
	ended(day9.Add(14*time.Hour), 30*time.Minute, "") // untyped counts as a nap
	// Crosses local midnight (23:30 on the 8th → 00:30 on the 9th): one
	// nap of 60 minutes, not two half-naps in two day buckets.
	ended(day9.Add(-30*time.Minute), 60*time.Minute, "nap")

	// Not counted: a night session, a nap that started before the window
	// (2026-01-03, which SleepsInRange still returns), and a running nap.
	ended(day9.Add(20*time.Hour), 10*time.Hour, "night")
	ended(time.Date(2026, 1, 3, 13, 0, 0, 0, time.UTC), 3*time.Hour, "nap")
	sleep(fixedNow.Add(-30*time.Minute), nil, "nap")

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if v := res.JSON["avgNapMin"]; v != float64(50) {
		t.Errorf("avgNapMin = %v, want 50 (150 min over 3 naps)", v)
	}
	// 3 naps over a 7-day window, one decimal like avgFeeds.
	if v := res.JSON["avgNaps"]; v != float64(0.4) {
		t.Errorf("avgNaps = %v, want 0.4", v)
	}
}

// With no completed nap in the window both numbers are zero rather than
// absent — the SPA decides whether to render the line, and a required
// field keeps the generated client types free of optionals.
func TestGetStatsNapAveragesAreZeroWithoutNaps(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	fixedNow := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	a.SetNow(fixedNow)
	day9 := time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC)

	body := map[string]any{
		"babyId":    babyID,
		"startTime": day9.Add(20 * time.Hour).Format(time.RFC3339),
		"endTime":   day9.Add(30 * time.Hour).Format(time.RFC3339),
		"type":      "night",
	}
	if res := a.Do(http.MethodPost, "/api/sleep", cookie, body); res.Status != http.StatusCreated {
		t.Fatalf("create sleep: %d %s", res.Status, res.Raw)
	}

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if v := res.JSON["avgNapMin"]; v != float64(0) {
		t.Errorf("avgNapMin = %v, want 0", v)
	}
	if v := res.JSON["avgNaps"]; v != float64(0) {
		t.Errorf("avgNaps = %v, want 0", v)
	}
}
