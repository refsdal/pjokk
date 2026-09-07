package jobs_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// The reminder sweep (issue #45). The "one nudge per gap, reset by a new
// log" rule is push.test.ts's original feed-reminder contract, now per
// kind; fixed times, quiet hours, days and per-baby scoping are new.

const (
	testEndpoint = "https://fcm.googleapis.com/sub/remind"
	testP256     = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM"
	testAuth     = "tBHItJI5svbpez7KI4CCXg"
)

func subscribe(t *testing.T, a *testrig.AppRig, cookie, suffix string) {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, map[string]any{
		"endpoint": testEndpoint + suffix, "p256dh": testP256, "auth": testAuth,
	})
	if res.Status != http.StatusOK {
		t.Fatalf("subscribe status = %d, body %s", res.Status, res.Raw)
	}
}

func addReminder(t *testing.T, a *testrig.AppRig, cookie string, body map[string]any) string {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/reminders", cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("create reminder %v: status %d, body %s", body, res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	return id
}

func run(t *testing.T, a *testrig.AppRig, now time.Time) int {
	t.Helper()
	sent, err := jobs.RunReminders(context.Background(), depsFor(a), now)
	if err != nil {
		t.Fatalf("RunReminders: %v", err)
	}
	return sent
}

func logAt(t *testing.T, a *testrig.AppRig, cookie, path string, body map[string]any) {
	t.Helper()
	res := a.Do(http.MethodPost, path, cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("POST %s: status %d, body %s", path, res.Status, res.Raw)
	}
}

// Ports push.test.ts's "feed reminders: one nudge per gap, reset by a new
// feed" onto a since_last reminder.
func TestRunRemindersOneNudgePerGapResetByNewFeed(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "1")
	addReminder(t, a, cookie, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC"})

	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	feedAt := func(at time.Time) {
		logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": at.Format(time.RFC3339), "type": "bottle", "amountMl": 100})
	}

	// Last feed 2 h ago: below 3 h — nothing.
	feedAt(now.Add(-2 * time.Hour))
	if sent := run(t, a, now); sent != 0 {
		t.Fatalf("sent = %d, want 0", sent)
	}
	// 4 h later the gap is 6 h: exactly one push.
	later := now.Add(4 * time.Hour)
	if sent := run(t, a, later); sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
	// Same gap, next tick: latched.
	if sent := run(t, a, later.Add(15*time.Minute)); sent != 0 {
		t.Fatalf("sent (repeat) = %d, want 0", sent)
	}
	// A new feed starts a new gap; once IT exceeds 3 h, remind again.
	feedAt(now.Add(5 * time.Hour))
	if sent := run(t, a, now.Add(9*time.Hour)); sent != 1 {
		t.Fatalf("sent (new gap) = %d, want 1", sent)
	}
}

func TestRunRemindersSkipsKindNeverLogged(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	subscribe(t, a, cookie, "2")
	addReminder(t, a, cookie, map[string]any{"kind": "diaper", "mode": "since_last", "intervalMin": 120, "tz": "UTC"})
	if sent := run(t, a, time.Now()); sent != 0 {
		t.Fatalf("sent = %d, want 0 (no diapers ever logged)", sent)
	}
}

// Quiet hours: a since_last reminder that comes due inside the window is
// held, not latched, so it fires at the first tick after the window ends.
func TestRunRemindersHonoursQuietHours(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "3")
	addReminder(t, a, cookie, map[string]any{
		"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "Europe/Oslo", "quietStart": 22, "quietEnd": 7,
	})
	oslo, _ := time.LoadLocation("Europe/Oslo")
	lastFeed := time.Date(2026, 3, 16, 23, 0, 0, 0, oslo)
	logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": lastFeed.Format(time.RFC3339), "type": "bottle", "amountMl": 90})

	// 03:00 Oslo, gap 4 h, inside quiet hours: held.
	if sent := run(t, a, lastFeed.Add(4*time.Hour)); sent != 0 {
		t.Fatalf("sent at 03:00 = %d, want 0 (quiet hours)", sent)
	}
	// 07:00 Oslo: the window has ended and the gap is still open — fires.
	if sent := run(t, a, lastFeed.Add(8*time.Hour)); sent != 1 {
		t.Fatalf("sent at 07:00 = %d, want 1", sent)
	}
}

// A fixed-time reminder fires once per matching local day, on or after its
// minute, never twice for the same slot, and not at all for a slot more than
// an hour past (after a cron outage a late nudge is worse than none).
func TestRunRemindersFixedTimeOncePerDayInLocalTime(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	subscribe(t, a, cookie, "4")
	// 09:00 Oslo on weekdays only (Mon–Fri = bits 0..4 = 31).
	addReminder(t, a, cookie, map[string]any{
		"kind": "custom", "mode": "at_time", "atMinute": 9 * 60, "days": 31, "tz": "Europe/Oslo", "label": "Vitamin D",
	})
	oslo, _ := time.LoadLocation("Europe/Oslo")
	monday := time.Date(2026, 3, 16, 0, 0, 0, 0, oslo) // 2026-03-16 is a Monday

	if sent := run(t, a, monday.Add(8*time.Hour+50*time.Minute)); sent != 0 {
		t.Fatalf("08:50 = %d, want 0 (not yet)", sent)
	}
	if sent := run(t, a, monday.Add(9*time.Hour+5*time.Minute)); sent != 1 {
		t.Fatalf("09:05 = %d, want 1", sent)
	}
	if sent := run(t, a, monday.Add(9*time.Hour+20*time.Minute)); sent != 0 {
		t.Fatalf("09:20 = %d, want 0 (already fired today)", sent)
	}
	// Tuesday, but the cron was down until 11:30: latched without sending.
	tuesday := monday.Add(24 * time.Hour)
	if sent := run(t, a, tuesday.Add(11*time.Hour+30*time.Minute)); sent != 0 {
		t.Fatalf("Tuesday 11:30 = %d, want 0 (more than an hour past the slot)", sent)
	}
	if sent := run(t, a, tuesday.Add(11*time.Hour+45*time.Minute)); sent != 0 {
		t.Fatalf("Tuesday 11:45 = %d, want 0 (latched)", sent)
	}
	// Saturday is not in the mask.
	saturday := monday.Add(5 * 24 * time.Hour)
	if sent := run(t, a, saturday.Add(9*time.Hour+5*time.Minute)); sent != 0 {
		t.Fatalf("Saturday 09:05 = %d, want 0 (weekdays only)", sent)
	}
	// Next Monday fires again.
	if sent := run(t, a, monday.Add(7*24*time.Hour+9*time.Hour+5*time.Minute)); sent != 1 {
		t.Fatalf("next Monday 09:05 = %d, want 1", sent)
	}
}

// Per-baby scoping and a medicine keyed on a name: a dose for the other
// baby, or of another medicine, does not reset the gap.
func TestRunRemindersPerBabyAndPerMedicine(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	nora := a.NewBaby(familyID, "Nora")
	ola := a.NewBaby(familyID, "Ola")
	subscribe(t, a, cookie, "5")
	addReminder(t, a, cookie, map[string]any{
		"kind": "medicine", "mode": "since_last", "intervalMin": 360, "tz": "UTC", "babyId": nora, "label": "Paracetamol",
	})

	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	dose := func(baby, name string, at time.Time) {
		logAt(t, a, cookie, "/api/medicine", map[string]any{"babyId": baby, "time": at.Format(time.RFC3339), "name": name, "amount": 2.5, "unit": "ml"})
	}
	dose(nora, "paracetamol ", now.Add(-7*time.Hour)) // 7 h ago: due (case/space-insensitive match)
	dose(ola, "Paracetamol", now.Add(-1*time.Hour))   // the other baby's dose must not reset it
	dose(nora, "Ibuprofen", now.Add(-1*time.Hour))    // another medicine must not either
	if sent := run(t, a, now); sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
	dose(nora, "Paracetamol", now)
	if sent := run(t, a, now.Add(2*time.Hour)); sent != 0 {
		t.Fatalf("sent 2 h after a fresh dose = %d, want 0", sent)
	}
}
