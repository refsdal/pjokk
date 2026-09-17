package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Barnehage days against home days, through the API (issue #111). Fixed
// clock, tz=0: "today" is Saturday 2026-01-10, so the 7-day window is
// Sunday 4th to Saturday 10th and today is left out of both groups.
func TestStatsDaycareSplit(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	a.SetNow(time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC))
	at := func(d, h, m int) string { return time.Date(2026, 1, d, h, m, 0, 0, time.UTC).Format(time.RFC3339) }
	post := func(path string, body map[string]any) {
		t.Helper()
		body["babyId"] = babyID
		if res := a.Do(http.MethodPost, path, cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("POST %s %v = %d %s", path, body, res.Status, res.Raw)
		}
	}

	// Mon 5th – Thu 8th at barnehage: a one-hour nap, bed at 18:50.
	for d := 5; d <= 8; d++ {
		post("/api/daycare", map[string]any{"startTime": at(d, 8, 0), "endTime": at(d, 15, 30)})
		post("/api/sleep", map[string]any{"startTime": at(d, 11, 30), "endTime": at(d, 12, 30), "type": "nap"})
		post("/api/sleep", map[string]any{"startTime": at(d, 18, 50), "endTime": at(d+1, 6, 20), "type": "night"})
	}
	// Sun 4th and Fri 9th at home: a two-hour nap, bed at 19:20.
	for _, d := range []int{4, 9} {
		post("/api/sleep", map[string]any{"startTime": at(d, 12, 0), "endTime": at(d, 14, 0), "type": "nap"})
		post("/api/sleep", map[string]any{"startTime": at(d, 19, 20), "endTime": at(d+1, 6, 20), "type": "night"})
	}

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("GET stats = %d %s", res.Status, res.Raw)
	}
	split, _ := res.JSON["daycareSplit"].(map[string]any)
	if split == nil {
		t.Fatalf("daycareSplit = %v, want a split: %s", res.JSON["daycareSplit"], res.Raw)
	}
	at0, home := split["daycare"].(map[string]any), split["home"].(map[string]any)
	for name, c := range map[string]struct {
		got  any
		want float64
	}{
		"barnehage days": {at0["days"], 4}, "barnehage nap": {at0["avgNapMin"], 60},
		"barnehage night": {at0["avgNightSleepMin"], 690}, "barnehage bedtime": {at0["avgBedtimeMin"], 18*60 + 50},
		"home days": {home["days"], 2}, "home nap": {home["avgNapMin"], 120},
		"home night": {home["avgNightSleepMin"], 660}, "home bedtime": {home["avgBedtimeMin"], 19*60 + 20},
	} {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", name, c.got, c.want)
		}
	}

	// Each day says which kind it was.
	marked := map[string]bool{}
	for _, d := range res.JSON["days"].([]any) {
		m := d.(map[string]any)
		marked[m["date"].(string)] = m["daycare"].(bool)
	}
	if !marked["2026-01-05"] || !marked["2026-01-08"] || marked["2026-01-04"] || marked["2026-01-09"] || marked["2026-01-10"] {
		t.Errorf("daycare flags = %v", marked)
	}

	// A baby who never went has no split, and the key is still there.
	plain := a.NewBaby(familyID, "Emil")
	none := a.Do(http.MethodGet, "/api/stats?babyId="+plain+"&days=7&tz=0", cookie, nil)
	if v, present := none.JSON["daycareSplit"]; !present || v != nil {
		t.Errorf("daycareSplit with no barnehage = %v (present %v), want an explicit null", v, present)
	}
}

// Ill days through the API (issue #127). Fixed clock, tz=0: today is
// Saturday 2026-01-10, the 7-day window is the 4th to the 10th.
func TestStatsIllDays(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	a.SetNow(time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC))
	at := func(d, h int) string { return time.Date(2026, 1, d, h, 0, 0, 0, time.UTC).Format(time.RFC3339) }

	none := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if none.JSON["illDays"] != float64(0) || none.JSON["illEpisodes"] != float64(0) {
		t.Errorf("with no illness: illDays %v, illEpisodes %v, want 0 and 0", none.JSON["illDays"], none.JSON["illEpisodes"])
	}

	// Omgangssyke from the afternoon of the 5th to the morning of the 7th,
	// and a cold that began yesterday and is still open.
	for _, body := range []map[string]any{
		{"babyId": babyID, "startTime": at(5, 15), "endTime": at(7, 9), "symptoms": []string{"vomiting"}},
		{"babyId": babyID, "startTime": at(9, 8), "symptoms": []string{"cold"}},
	} {
		if res := a.Do(http.MethodPost, "/api/illness", cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("seed illness: %d %s", res.Status, res.Raw)
		}
	}
	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if res.JSON["illDays"] != float64(5) || res.JSON["illEpisodes"] != float64(2) {
		t.Errorf("illDays %v, illEpisodes %v, want 5 (5th, 6th, 7th, 9th, 10th) and 2", res.JSON["illDays"], res.JSON["illEpisodes"])
	}
	ill := map[string]bool{}
	for _, d := range res.JSON["days"].([]any) {
		m := d.(map[string]any)
		ill[m["date"].(string)] = m["ill"].(bool)
	}
	for date, want := range map[string]bool{"2026-01-04": false, "2026-01-05": true, "2026-01-06": true, "2026-01-07": true, "2026-01-08": false, "2026-01-09": true, "2026-01-10": true} {
		if ill[date] != want {
			t.Errorf("%s ill = %v, want %v", date, ill[date], want)
		}
	}
	// A one-day window sees only today's.
	today := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=1&tz=0", cookie, nil)
	if today.JSON["illDays"] != float64(1) || today.JSON["illEpisodes"] != float64(1) {
		t.Errorf("one-day window: illDays %v, illEpisodes %v, want 1 and 1", today.JSON["illDays"], today.JSON["illEpisodes"])
	}
}
