package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Ports apps/api/test/sleep.test.ts's "summary bundles last feed, last
// diaper and sleep state" case.
func TestSummaryBundlesLastFeedLastDiaperAndSleepState(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	now := time.Now().UTC()

	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     now.Add(-2 * time.Hour).Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 120,
	})
	a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   now.Add(-40 * time.Minute).Format(time.RFC3339),
		"type":   "wet",
	})
	a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": now.Add(-25 * time.Minute).Format(time.RFC3339),
	})

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}

	lastFeed := res.JSON["lastFeed"].(map[string]any)
	if lastFeed["amountMl"] != float64(120) {
		t.Errorf("lastFeed.amountMl = %v, want 120", lastFeed["amountMl"])
	}
	if lastFeed["caretakerName"] != "Rig admin" {
		t.Errorf("lastFeed.caretakerName = %v, want %q", lastFeed["caretakerName"], "Rig admin")
	}
	lastDiaper := res.JSON["lastDiaper"].(map[string]any)
	if lastDiaper["type"] != "wet" {
		t.Errorf("lastDiaper.type = %v, want %q", lastDiaper["type"], "wet")
	}
	activeSleep, ok := res.JSON["activeSleep"].(map[string]any)
	if !ok {
		t.Fatalf("activeSleep = %v, want an object", res.JSON["activeSleep"])
	}
	if activeSleep["endTime"] != nil {
		t.Errorf("activeSleep.endTime = %v, want nil", activeSleep["endTime"])
	}
}

func TestSummaryUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/summary?babyId=does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

// Ports apps/api/test/feedback-batch.test.ts's "summary today block" case
// (tz=0, the default/UTC window).
func TestSummaryTodayBlockCountsFeedsDiapersSleep(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// Pin "now" well inside a UTC day so the tz=0 window unambiguously
	// contains every event this test logs "now".
	now := time.Date(2026, 3, 15, 12, 0, 0, 0, time.UTC)
	a.SetNow(now)

	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "bottle", "amountMl": 100,
	})
	a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "solids", "amountMl": 50,
	})
	a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "wet",
	})
	a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID, "time": now.Format(time.RFC3339), "type": "both",
	})
	a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": now.Add(-30 * time.Minute).Format(time.RFC3339),
		"endTime":   now.Add(-10 * time.Minute).Format(time.RFC3339),
	})

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	today := res.JSON["today"].(map[string]any)
	if today["feeds"] != float64(2) {
		t.Errorf("today.feeds = %v, want 2", today["feeds"])
	}
	if today["intakeMl"] != float64(100) {
		t.Errorf("today.intakeMl = %v, want 100", today["intakeMl"])
	}
	if today["solidsG"] != float64(50) {
		t.Errorf("today.solidsG = %v, want 50", today["solidsG"])
	}
	if today["wet"] != float64(1) {
		t.Errorf("today.wet = %v, want 1", today["wet"])
	}
	if today["dirty"] != float64(0) {
		t.Errorf("today.dirty = %v, want 0", today["dirty"])
	}
	if today["both"] != float64(1) {
		t.Errorf("today.both = %v, want 1", today["both"])
	}
	if today["sleepMin"] != float64(20) {
		t.Errorf("today.sleepMin = %v, want 20 (a 20-minute completed nap fully inside the window)", today["sleepMin"])
	}
}

// tz edge: the SAME event counts as "today" under one offset and
// "yesterday" under another, proving the `today` window follows the
// caller's local day (tz query param), not the server's UTC day. See
// internal/api/summary.go's doc comment for the exact math this reproduces
// by hand: tz=-120 (local = UTC+2h) shifts the local day boundary to
// 22:00 UTC the previous day.
func TestSummaryTzEdgeChangesTodaysWindow(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	now := time.Date(2026, 3, 10, 1, 0, 0, 0, time.UTC)
	a.SetNow(now)

	// 23:00 UTC the PREVIOUS day: outside tz=0's UTC-day window
	// [2026-03-10T00:00Z, 2026-03-11T00:00Z), but inside tz=-120's local-day
	// window [2026-03-09T22:00Z, 2026-03-10T22:00Z).
	edgeTime := time.Date(2026, 3, 9, 23, 0, 0, 0, time.UTC)
	res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID, "time": edgeTime.Format(time.RFC3339), "type": "bottle", "amountMl": 10,
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("POST feed status = %d, body %s", res.Status, res.Raw)
	}

	utcSummary := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	utcToday := utcSummary.JSON["today"].(map[string]any)
	if utcToday["feeds"] != float64(0) {
		t.Errorf("tz=0 today.feeds = %v, want 0 (the feed is in yesterday's UTC day)", utcToday["feeds"])
	}

	localSummary := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=-120", cookie, nil)
	localToday := localSummary.JSON["today"].(map[string]any)
	if localToday["feeds"] != float64(1) {
		t.Errorf("tz=-120 today.feeds = %v, want 1 (the feed is in today's local day)", localToday["feeds"])
	}
}

// activePlay is backed by internal/db/queries/play.sql's ActivePlay; the
// row is seeded by direct SQL here (rather than through POST /api/play) so
// this test stays independent of play.go's own route tests.
func TestSummaryActivePlayField(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	ctx := context.Background()

	var caretakerID string
	if err := a.Rig.Pool.QueryRow(ctx,
		`SELECT "user_id" FROM "organization_members" WHERE "organization_id" = $1 LIMIT 1`, familyID,
	).Scan(&caretakerID); err != nil {
		t.Fatalf("find the admin's user id: %v", err)
	}
	var playID string
	if err := a.Rig.Pool.QueryRow(ctx, `
		INSERT INTO "play_log" ("family_id", "baby_id", "caretaker_id", "type", "start_time", "end_time")
		VALUES ($1, $2, $3, 'tummy', now(), NULL) RETURNING "id"`,
		familyID, babyID, caretakerID,
	).Scan(&playID); err != nil {
		t.Fatalf("seed an active play_log row directly: %v", err)
	}

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	activePlay, ok := res.JSON["activePlay"].(map[string]any)
	if !ok {
		t.Fatalf("activePlay = %v, want an object", res.JSON["activePlay"])
	}
	if activePlay["id"] != playID {
		t.Errorf("activePlay.id = %v, want %q", activePlay["id"], playID)
	}
	if activePlay["type"] != "tummy" {
		t.Errorf("activePlay.type = %v, want %q", activePlay["type"], "tummy")
	}
	if activePlay["endTime"] != nil {
		t.Errorf("activePlay.endTime = %v, want nil", activePlay["endTime"])
	}
}

func TestSummaryFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyA, cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("cross-family GET summary status = %d, want 404", res.Status)
	}

	own := a.Do(http.MethodGet, "/api/summary?babyId="+babyA, cookieA, nil)
	if own.Status != http.StatusOK {
		t.Fatalf("own-family GET summary status = %d, body %s", own.Status, own.Raw)
	}
}

// The Home screen shows a temperature card, so the summary carries the latest
// temperature the way it already carries the last feed and last diaper. It
// must be the latest TEMPERATURE specifically, not the latest measurement:
// weighing the baby after taking her temperature must not blank the card, and
// must certainly not put 8.4 on it as if it were degrees.
func TestSummaryLastTemperatureIgnoresOtherMeasurementTypes(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	now := time.Now().UTC()

	// An older temperature, a newer one, and a weight newer than both.
	for _, m := range []struct {
		typ   string
		value float64
		at    time.Time
	}{
		{"temperature", 37.2, now.Add(-6 * time.Hour)},
		{"temperature", 39.4, now.Add(-2 * time.Hour)},
		{"weight", 8.4, now.Add(-1 * time.Hour)},
	} {
		res := a.Do(http.MethodPost, "/api/measurements", cookie, map[string]any{
			"babyId": babyID,
			"time":   m.at.Format(time.RFC3339),
			"type":   m.typ,
			"value":  m.value,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("create %s: status %d, body %s", m.typ, res.Status, res.Raw)
		}
	}

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	last, ok := res.JSON["lastTemperature"].(map[string]any)
	if !ok {
		t.Fatalf("lastTemperature = %v, want an object", res.JSON["lastTemperature"])
	}
	if last["value"] != 39.4 {
		t.Errorf("lastTemperature.value = %v, want 39.4", last["value"])
	}
	if last["type"] != "temperature" {
		t.Errorf("lastTemperature.type = %v, want temperature", last["type"])
	}
}

// A family that has never taken a temperature gets an explicit null, not a
// missing key — the field is required-and-nullable, so the SPA can render the
// card's absence without probing for undefined.
func TestSummaryLastTemperatureIsNullWhenNoneRecorded(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	v, present := res.JSON["lastTemperature"]
	if !present {
		t.Fatalf("lastTemperature key absent; want present and null")
	}
	if v != nil {
		t.Errorf("lastTemperature = %v, want null", v)
	}
}
