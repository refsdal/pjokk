package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Stats — ports apps/api/test/stats.test.ts's "stats" describe block.
// Unlike the TS suite (which anchors on `new Date()` and works around a
// midnight-window flake by picking "yesterday" relative to the real
// clock — see stats.test.ts's own comment), this port pins the rig's clock
// via SetNow, so the anchor day is a fixed date rather than "yesterday
// relative to whenever the suite happens to run".
//
// The TS predecessor's statsMonth premium gate (402 when days>7) is
// removed in this port (internal/api/stats.go's package doc comment);
// TestGetStatsDaysAbove7IsFreeOnDefaultPlan replaces the 402-vs-premium
// case that would otherwise sit here, asserting 200 with NO plan setup.
// -----------------------------------------------------------------------

const statsHour = time.Hour

func TestGetStatsBucketsPerLocalDaySplittingSleepAcrossMidnight(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	// Fixed clock: "today" is 2026-01-10 (UTC, tz=0), so "yesterday"
	// (anchorMidnight) is 2026-01-09T00:00:00Z.
	fixedNow := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	a.SetNow(fixedNow)
	anchorMidnight := time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC)

	// A session from 22:00 the day before anchorMidnight to 06:00
	// anchorMidnight's day: 2h in the day before, 6h in anchorMidnight's
	// day.
	sleepRes := a.Do(http.MethodPost, "/api/sleep", cookie, map[string]any{
		"babyId":    babyID,
		"startTime": anchorMidnight.Add(-2 * statsHour).Format(time.RFC3339),
		"endTime":   anchorMidnight.Add(6 * statsHour).Format(time.RFC3339),
	})
	if sleepRes.Status != http.StatusCreated {
		t.Fatalf("create sleep status = %d, body %s", sleepRes.Status, sleepRes.Raw)
	}

	feed := func(at time.Time, body map[string]any) {
		body["babyId"] = babyID
		body["time"] = at.Format(time.RFC3339)
		res := a.Do(http.MethodPost, "/api/feeds", cookie, body)
		if res.Status != http.StatusCreated {
			t.Fatalf("create feed status = %d, body %s", res.Status, res.Raw)
		}
	}
	feed(anchorMidnight.Add(-5*statsHour), map[string]any{"type": "bottle", "amountMl": 200})
	feed(anchorMidnight.Add(1*statsHour), map[string]any{"type": "bottle", "amountMl": 120})
	feed(anchorMidnight.Add(2*statsHour), map[string]any{"type": "solids", "amountMl": 60})
	feed(anchorMidnight.Add(3*statsHour), map[string]any{"type": "breast", "side": "left"})

	diaperRes := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   anchorMidnight.Add(1 * statsHour).Format(time.RFC3339),
		"type":   "wet",
	})
	if diaperRes.Status != http.StatusCreated {
		t.Fatalf("create diaper status = %d, body %s", diaperRes.Status, diaperRes.Raw)
	}

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	days, _ := res.JSON["days"].([]any)
	if len(days) != 7 {
		t.Fatalf("days = %d entries, want 7", len(days))
	}

	dayBefore := days[4].(map[string]any)
	anchorDay := days[5].(map[string]any)

	if v := anchorDay["sleepMin"]; v != float64(360) {
		t.Errorf("anchorDay.sleepMin = %v, want 360", v)
	}
	if v := dayBefore["sleepMin"]; v != float64(120) {
		t.Errorf("dayBefore.sleepMin = %v, want 120", v)
	}
	if v := dayBefore["intakeMl"]; v != float64(200) {
		t.Errorf("dayBefore.intakeMl = %v, want 200", v)
	}
	// Intake sums bottle ml only — the solids feed's 60 (grams) don't
	// count.
	if v := anchorDay["intakeMl"]; v != float64(120) {
		t.Errorf("anchorDay.intakeMl = %v, want 120", v)
	}
	if v := anchorDay["feeds"]; v != float64(3) {
		t.Errorf("anchorDay.feeds = %v, want 3", v)
	}
	if v := anchorDay["diapers"]; v != float64(1) {
		t.Errorf("anchorDay.diapers = %v, want 1", v)
	}
	// avgSleepMin = round((120+360)/7) = 69; avgIntakeMl = round(320/7) = 46.
	if v := res.JSON["avgSleepMin"]; v != float64(69) {
		t.Errorf("avgSleepMin = %v, want 69", v)
	}
	if v := res.JSON["avgIntakeMl"]; v != float64(46) {
		t.Errorf("avgIntakeMl = %v, want 46", v)
	}
}

func TestGetStatsReturnsLatestWeightWithPredecessor(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	post := func(daysAgo int, typ string, value float64) {
		res := a.Do(http.MethodPost, "/api/measurements", cookie, map[string]any{
			"babyId": babyID,
			"time":   time.Now().Add(-time.Duration(daysAgo) * 24 * statsHour).Format(time.RFC3339),
			"type":   typ,
			"value":  value,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("create measurement status = %d, body %s", res.Status, res.Raw)
		}
	}
	post(20, "weight", 7.9)
	post(2, "weight", 8.4)
	// A length measurement must not interfere.
	post(0, "length", 71)

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	weight, _ := res.JSON["weight"].(map[string]any)
	if weight == nil {
		t.Fatalf("weight = nil, want an object")
	}
	if weight["value"] != 8.4 {
		t.Errorf("weight.value = %v, want 8.4", weight["value"])
	}
	if weight["prevValue"] != 7.9 {
		t.Errorf("weight.prevValue = %v, want 7.9", weight["prevValue"])
	}
}

func TestGetStatsIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, _ := a.NewFamily("Family A", "a@example.com")
	babyA := a.NewBaby(familyA, "Nora")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyA+"&tz=0", cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.Status)
	}
}

func TestGetStatsIntakeSumsBottleMlOnly(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	now := time.Now().UTC().Format(time.RFC3339)
	for _, body := range []map[string]any{
		{"type": "bottle", "amountMl": 120},
		{"type": "solids", "amountMl": 80},
	} {
		body["babyId"] = babyID
		body["time"] = now
		res := a.Do(http.MethodPost, "/api/feeds", cookie, body)
		if res.Status != http.StatusCreated {
			t.Fatalf("create feed status = %d, body %s", res.Status, res.Raw)
		}
	}

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=7", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	days, _ := res.JSON["days"].([]any)
	today := days[len(days)-1].(map[string]any)
	if today["feeds"] != float64(2) {
		t.Errorf("today.feeds = %v, want 2", today["feeds"])
	}
	if today["intakeMl"] != float64(120) {
		t.Errorf("today.intakeMl = %v, want 120", today["intakeMl"])
	}
}

// TestGetStatsDaysAbove7IsFreeOnDefaultPlan replaces the TS predecessor's
// 402-vs-premium test: this port removes the statsMonth gate entirely (see
// internal/api/stats.go's package doc comment), so a days=30 request on a
// family with NO plan set up at all (default "free") must still succeed.
func TestGetStatsDaysAbove7IsFreeOnDefaultPlan(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=30&tz=0", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s, want 200 (no plan gate)", res.Status, res.Raw)
	}
	days, _ := res.JSON["days"].([]any)
	if len(days) != 30 {
		t.Errorf("days = %d entries, want 30", len(days))
	}

	res90 := a.Do(http.MethodGet, "/api/stats?babyId="+babyID+"&days=90&tz=0", cookie, nil)
	if res90.Status != http.StatusOK {
		t.Fatalf("days=90 status = %d, body %s, want 200", res90.Status, res90.Raw)
	}
}

func TestGetStatsUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/stats?babyId=does-not-exist&tz=0", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.Status)
	}
	if res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("code = %v, want NOT_FOUND", res.JSON["code"])
	}
}

func TestGetStatsRejectUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/stats?babyId=x&tz=0", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}
