package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Shared nursing / pump timer (issue #44): a feed_timer row per (baby,
// kind) that every caretaker sees, accrues per-side seconds on the server's
// clock, and turns into a feed_log / pump_log row on stop. Structurally a
// cousin of the sleep/play session tests, but the timer is its own table:
// a completed feed has one `time`, not a start and an end, so "end_time IS
// NULL" could not have meant "running" here.
// -----------------------------------------------------------------------

func TestFeedTimerStartSwitchStopBecomesBreastFeed(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)
	a.SetNow(t0)

	start := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{
		"babyId": babyID, "kind": "breast", "side": "left",
	})
	if start.Status != http.StatusCreated {
		t.Fatalf("start status = %d, body %s", start.Status, start.Raw)
	}
	if start.JSON["kind"] != "breast" || start.JSON["runningSide"] != "left" || start.JSON["leftSec"] != float64(0) {
		t.Errorf("start = %v, want breast/left/0", start.JSON)
	}
	if start.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want Rig admin", start.JSON["caretakerName"])
	}
	id, _ := start.JSON["id"].(string)

	// A second breast timer for the same baby is refused; a pump timer is
	// not — feeding one side and pumping the other is a real thing.
	again := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{
		"babyId": babyID, "kind": "breast",
	})
	if again.Status != http.StatusConflict || again.JSON["code"] != "ALREADY_ACTIVE" {
		t.Errorf("second start: status %d body %s, want 409 ALREADY_ACTIVE", again.Status, again.Raw)
	}

	lookup := a.Do(http.MethodGet, "/api/feeds/timer?babyId="+babyID, cookie, nil)
	if lookup.Status != http.StatusOK {
		t.Fatalf("GET status = %d, body %s", lookup.Status, lookup.Raw)
	}
	if b, _ := lookup.JSON["breast"].(map[string]any); b["id"] != id {
		t.Errorf("lookup.breast = %v, want the running timer", lookup.JSON["breast"])
	}
	if lookup.JSON["pump"] != nil {
		t.Errorf("lookup.pump = %v, want null", lookup.JSON["pump"])
	}

	// Five minutes on the left, then switch: the left seconds are banked
	// on the server's clock, and the right side starts counting.
	a.SetNow(t0.Add(5 * time.Minute))
	sw := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/side", cookie, map[string]any{"side": "right"})
	if sw.Status != http.StatusOK {
		t.Fatalf("switch status = %d, body %s", sw.Status, sw.Raw)
	}
	if sw.JSON["leftSec"] != float64(300) || sw.JSON["rightSec"] != float64(0) || sw.JSON["runningSide"] != "right" {
		t.Errorf("after switch = %v, want leftSec 300, rightSec 0, running right", sw.JSON)
	}

	// Pause: nothing runs, nothing is lost.
	a.SetNow(t0.Add(7 * time.Minute))
	pause := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/side", cookie, map[string]any{"side": nil})
	if pause.Status != http.StatusOK || pause.JSON["runningSide"] != nil || pause.JSON["rightSec"] != float64(120) {
		t.Errorf("pause = status %d %v, want running null and rightSec 120", pause.Status, pause.JSON)
	}
	if pause.JSON["sideStartedAt"] != nil {
		t.Errorf("sideStartedAt while paused = %v, want null", pause.JSON["sideStartedAt"])
	}

	// Resume right for one more minute, then stop: 5 min left + 3 min right.
	a.SetNow(t0.Add(7 * time.Minute))
	a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/side", cookie, map[string]any{"side": "right"})
	a.SetNow(t0.Add(8 * time.Minute))
	stop := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", cookie, map[string]any{"notes": "sleepy"})
	if stop.Status != http.StatusCreated {
		t.Fatalf("stop status = %d, body %s", stop.Status, stop.Raw)
	}
	if stop.JSON["kind"] != "breast" || stop.JSON["pump"] != nil {
		t.Errorf("stop = %v, want kind breast and pump null", stop.JSON)
	}
	feed, _ := stop.JSON["feed"].(map[string]any)
	if feed["type"] != "breast" || feed["side"] != "both" || feed["leftMin"] != float64(5) || feed["rightMin"] != float64(3) || feed["durationMin"] != float64(8) {
		t.Errorf("feed = %v, want breast/both/5/3/8", feed)
	}
	if feed["time"] != t0.Format(time.RFC3339) {
		t.Errorf("feed.time = %v, want the timer's start %s", feed["time"], t0.Format(time.RFC3339))
	}
	if feed["notes"] != "sleepy" {
		t.Errorf("feed.notes = %v, want sleepy", feed["notes"])
	}

	// The timer is gone; a replayed stop is a 404, not a second feed.
	after := a.Do(http.MethodGet, "/api/feeds/timer?babyId="+babyID, cookie, nil)
	if after.JSON["breast"] != nil {
		t.Errorf("breast timer after stop = %v, want null", after.JSON["breast"])
	}
	replay := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", cookie, map[string]any{})
	if replay.Status != http.StatusNotFound {
		t.Errorf("replayed stop status = %d, want 404", replay.Status)
	}
	feeds := a.DoArray(http.MethodGet, "/api/feeds?babyId="+babyID, cookie, nil)
	if len(feeds.JSON) != 1 {
		t.Errorf("feeds = %d rows, want exactly 1", len(feeds.JSON))
	}
}

func TestFeedTimerStopOverridesAndSubMinuteRounding(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)
	a.SetNow(t0)
	start := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{"babyId": babyID, "kind": "breast"})
	id, _ := start.JSON["id"].(string)
	if start.JSON["runningSide"] != "left" {
		t.Errorf("default side = %v, want left", start.JSON["runningSide"])
	}

	// 20 seconds still registers as one minute (the sheet's own rule), and
	// the sheet's steppers can override what the clock says.
	a.SetNow(t0.Add(20 * time.Second))
	stop := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", cookie, map[string]any{"rightMin": 4})
	if stop.Status != http.StatusCreated {
		t.Fatalf("stop status = %d, body %s", stop.Status, stop.Raw)
	}
	feed, _ := stop.JSON["feed"].(map[string]any)
	if feed["leftMin"] != float64(1) || feed["rightMin"] != float64(4) || feed["durationMin"] != float64(5) || feed["side"] != "both" {
		t.Errorf("feed = %v, want leftMin 1 (rounded up), rightMin 4 (override), 5 total, both", feed)
	}
}

func TestPumpTimerStopBecomesPumpLog(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)
	a.SetNow(t0)
	start := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{"babyId": babyID, "kind": "pump"})
	if start.Status != http.StatusCreated || start.JSON["runningSide"] != "both" {
		t.Fatalf("pump start: status %d body %s, want 201 and side both by default", start.Status, start.Raw)
	}
	id, _ := start.JSON["id"].(string)

	// A pump timer is one clock: it cannot be paused.
	pause := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/side", cookie, map[string]any{"side": nil})
	if pause.Status != http.StatusBadRequest {
		t.Errorf("pausing a pump timer status = %d, want 400", pause.Status)
	}

	a.SetNow(t0.Add(17 * time.Minute))
	stop := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", cookie, map[string]any{"amountMl": 90})
	if stop.Status != http.StatusCreated || stop.JSON["kind"] != "pump" || stop.JSON["feed"] != nil {
		t.Fatalf("stop = status %d %v, want 201, kind pump, feed null", stop.Status, stop.JSON)
	}
	pump, _ := stop.JSON["pump"].(map[string]any)
	if pump["side"] != "both" || pump["amountMl"] != float64(90) || pump["durationMin"] != float64(17) || pump["time"] != t0.Format(time.RFC3339) {
		t.Errorf("pump = %v, want both/90/17/start time", pump)
	}
	pumps := a.DoArray(http.MethodGet, "/api/pumps?babyId="+babyID, cookie, nil)
	if len(pumps.JSON) != 1 {
		t.Errorf("pumps = %d rows, want 1", len(pumps.JSON))
	}
}

func TestFeedTimerDiscardAndSummary(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	start := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{"babyId": babyID, "kind": "breast"})
	id, _ := start.JSON["id"].(string)
	pumpStart := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{"babyId": babyID, "kind": "pump"})
	pumpID, _ := pumpStart.JSON["id"].(string)

	// Home's one query carries both timers, like activeSleep / activePlay.
	sum := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if sum.Status != http.StatusOK {
		t.Fatalf("summary status = %d, body %s", sum.Status, sum.Raw)
	}
	if f, _ := sum.JSON["activeFeed"].(map[string]any); f["id"] != id {
		t.Errorf("summary.activeFeed = %v, want the breast timer", sum.JSON["activeFeed"])
	}
	if p, _ := sum.JSON["activePump"].(map[string]any); p["id"] != pumpID {
		t.Errorf("summary.activePump = %v, want the pump timer", sum.JSON["activePump"])
	}

	// Discard throws the timer away without logging anything.
	del := a.Do(http.MethodDelete, "/api/feeds/timer/"+id, cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("discard status = %d, body %s", del.Status, del.Raw)
	}
	if again := a.Do(http.MethodDelete, "/api/feeds/timer/"+id, cookie, nil); again.Status != http.StatusNotFound {
		t.Errorf("second discard status = %d, want 404", again.Status)
	}
	sum2 := a.Do(http.MethodGet, "/api/summary?babyId="+babyID+"&tz=0", cookie, nil)
	if sum2.JSON["activeFeed"] != nil {
		t.Errorf("summary.activeFeed after discard = %v, want null", sum2.JSON["activeFeed"])
	}
	feeds := a.DoArray(http.MethodGet, "/api/feeds?babyId="+babyID, cookie, nil)
	if len(feeds.JSON) != 0 {
		t.Errorf("feeds after discard = %d rows, want 0", len(feeds.JSON))
	}
}

func TestFeedTimerIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("A", "a@example.com")
	babyA := a.NewBaby(familyA, "Nora")
	_, cookieB := a.NewFamily("B", "b@example.com")

	start := a.Do(http.MethodPost, "/api/feeds/timer", cookieA, map[string]any{"babyId": babyA, "kind": "breast"})
	id, _ := start.JSON["id"].(string)

	if res := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/side", cookieB, map[string]any{"side": "right"}); res.Status != http.StatusNotFound {
		t.Errorf("cross-family switch status = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", cookieB, map[string]any{}); res.Status != http.StatusNotFound {
		t.Errorf("cross-family stop status = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/feeds/timer/"+id, cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("cross-family discard status = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodGet, "/api/feeds/timer?babyId="+babyA, cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("cross-family lookup status = %d, want 404 (unknown baby)", res.Status)
	}
	if res := a.Do(http.MethodPost, "/api/feeds/timer", cookieB, map[string]any{"babyId": babyA, "kind": "breast"}); res.Status != http.StatusNotFound {
		t.Errorf("cross-family start status = %d, want 404 (unknown baby)", res.Status)
	}
}

// Offline replay: the SPA sends the moment it tapped Start, so a paused
// mutation that reaches the server minutes later still starts the clock
// where the parent did.
func TestFeedTimerHonoursClientStartTime(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC)
	a.SetNow(t0.Add(3 * time.Minute))
	start := a.Do(http.MethodPost, "/api/feeds/timer", cookie, map[string]any{
		"babyId": babyID, "kind": "breast", "startTime": t0.Format(time.RFC3339),
	})
	if start.Status != http.StatusCreated {
		t.Fatalf("start status = %d, body %s", start.Status, start.Raw)
	}
	if start.JSON["startTime"] != t0.Format(time.RFC3339) || start.JSON["sideStartedAt"] != t0.Format(time.RFC3339) {
		t.Errorf("start = %v, want startTime and sideStartedAt at the client's %s", start.JSON, t0.Format(time.RFC3339))
	}
	id, _ := start.JSON["id"].(string)
	stop := a.Do(http.MethodPost, "/api/feeds/timer/"+id+"/stop", cookie, map[string]any{})
	feed, _ := stop.JSON["feed"].(map[string]any)
	if feed["leftMin"] != float64(3) {
		t.Errorf("leftMin = %v, want 3 (counted from the client's start)", feed["leftMin"])
	}
}
