package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// The Home awake card's nap line on GET /api/summary: today.naps and
// today.napMin, plus lastNightMin. No TS predecessor — this is new
// behaviour, not a port.
//
// A nap is any session NOT typed `night` — untyped sessions are the two-tap
// happy path, so they count as naps — the same split stats.go uses for
// avgNaps. naps/napMin follow today.sleeps' overlap rule (any part inside
// today's window; minutes clipped to it), so the one line never disagrees
// with itself.
//
// lastNightMin is "how long did she sleep last night": every completed
// `night` session of the newest completed night, where a night runs from
// local noon to noon and a session belongs to the night it started in (the
// Stats rule, stats_nights_test.go), so a real 3 am waking does not shrink
// the night to its last stretch.

func postSleep(t *testing.T, a *testrig.AppRig, cookie, babyID string, start, end time.Time, typ string) {
	t.Helper()
	body := map[string]any{"babyId": babyID, "startTime": start.Format(time.RFC3339)}
	if !end.IsZero() {
		body["endTime"] = end.Format(time.RFC3339)
	}
	if typ != "" {
		body["type"] = typ
	}
	res := a.Do(http.MethodPost, "/api/sleep", cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("POST /api/sleep status = %d, body %s", res.Status, res.Raw)
	}
}

func TestSummaryNapsExcludeNightAndLastNightSumsItsSessions(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	a.SetNow(now)
	at := func(day, h, m int) time.Time { return time.Date(2026, 3, day, h, m, 0, 0, time.UTC) }

	// The night before last: a different noon-to-noon night, never summed in.
	postSleep(t, a, cookie, babyID, at(13, 19, 0), at(14, 6, 0), "night")
	// Last night, with a real waking at 02:00: two sessions, one night.
	postSleep(t, a, cookie, babyID, at(14, 19, 30), at(15, 2, 0), "night")
	postSleep(t, a, cookie, babyID, at(15, 2, 30), at(15, 6, 30), "night")
	// Today's naps: one typed, one untyped.
	postSleep(t, a, cookie, babyID, at(15, 9, 0), at(15, 10, 0), "nap")
	postSleep(t, a, cookie, babyID, at(15, 10, 30), at(15, 11, 0), "")

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	today := res.JSON["today"].(map[string]any)
	if today["naps"] != float64(2) {
		t.Errorf("today.naps = %v, want 2 (typed + untyped; neither night session)", today["naps"])
	}
	if today["napMin"] != float64(60+30) {
		t.Errorf("today.napMin = %v, want 90", today["napMin"])
	}
	// Unchanged: sleeps/sleepMin still count every session, night included.
	if today["sleeps"] != float64(4) {
		t.Errorf("today.sleeps = %v, want 4", today["sleeps"])
	}
	if today["sleepMin"] != float64(120+240+60+30) {
		t.Errorf("today.sleepMin = %v, want 450", today["sleepMin"])
	}
	if res.JSON["lastNightMin"] != float64(390+240) {
		t.Errorf("lastNightMin = %v, want 630 (19:30–02:00 + 02:30–06:30)", res.JSON["lastNightMin"])
	}
}

// A night that ended more than a day ago is not "last night": the line would
// otherwise carry last week's number once a family stops typing nights.
func TestSummaryLastNightIsNullOnceTheNightIsOverADayOld(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	a.SetNow(time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC))
	// Ended 29 hours before now.
	postSleep(t, a, cookie, babyID,
		time.Date(2026, 3, 13, 20, 0, 0, 0, time.UTC), time.Date(2026, 3, 14, 7, 0, 0, 0, time.UTC), "night")

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if v, ok := res.JSON["lastNightMin"]; !ok || v != nil {
		t.Errorf("lastNightMin = %v (present %v), want null", v, ok)
	}
}

// A running night has no length yet: tonight's session in progress does not
// displace last night's completed one.
func TestSummaryLastNightIgnoresARunningNight(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	a.SetNow(time.Date(2026, 3, 15, 21, 0, 0, 0, time.UTC))
	postSleep(t, a, cookie, babyID,
		time.Date(2026, 3, 14, 20, 0, 0, 0, time.UTC), time.Date(2026, 3, 15, 6, 0, 0, 0, time.UTC), "night")
	postSleep(t, a, cookie, babyID, time.Date(2026, 3, 15, 20, 0, 0, 0, time.UTC), time.Time{}, "night")

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["lastNightMin"] != float64(600) {
		t.Errorf("lastNightMin = %v, want 600 (last night's 20:00–06:00, not tonight's running one)", res.JSON["lastNightMin"])
	}
}
