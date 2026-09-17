package jobs_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Barnehage holds since-last feed and diaper reminders (issue #105,
// reminders.go's sinceLastAnchor): nobody at home can answer one while she
// is there, and the pick-up answers it as a log would.

func dropOff(t *testing.T, a *testrig.AppRig, cookie, babyID string, at time.Time) string {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/daycare", cookie, map[string]any{"babyId": babyID, "startTime": at.Format(time.RFC3339)})
	if res.Status != http.StatusCreated {
		t.Fatalf("drop-off: status %d, body %s", res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	return id
}

func pickUp(t *testing.T, a *testrig.AppRig, cookie, id string, at time.Time) {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/daycare/"+id+"/pickup", cookie, map[string]any{"endTime": at.Format(time.RFC3339)})
	if res.Status != http.StatusOK {
		t.Fatalf("pick-up: status %d, body %s", res.Status, res.Raw)
	}
}

func TestRemindersHoldWhileAtDaycareAndPickUpAnswersThem(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "d1")
	addReminder(t, a, cookie, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC", "babyId": babyID})

	day := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	at := func(h, m int) time.Time { return day.Add(time.Duration(h)*time.Hour + time.Duration(m)*time.Minute) }

	logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": at(7, 15).Format(time.RFC3339), "type": "bottle", "amountMl": 150})
	id := dropOff(t, a, cookie, babyID, at(8, 0))

	// 11:00 and 15:00: gaps of nearly 4 h and 8 h, and she is there. Held.
	for _, h := range []int{11, 15} {
		if sent := run(t, a, at(h, 0)); sent != 0 {
			t.Fatalf("sent at %d:00 = %d, want 0 (at daycare)", h, sent)
		}
	}

	// Picked up 15:30. The gap now runs from the pick-up, not from 07:15.
	pickUp(t, a, cookie, id, at(15, 30))
	if sent := run(t, a, at(15, 45)); sent != 0 {
		t.Fatalf("sent right after pick-up = %d, want 0 (the pick-up answered it)", sent)
	}
	// Three hours on with nothing logged, it is a real gap again.
	if sent := run(t, a, at(18, 30)); sent != 1 {
		t.Fatalf("sent 3 h after pick-up = %d, want 1", sent)
	}
	if sent := run(t, a, at(18, 45)); sent != 0 {
		t.Fatalf("sent (repeat) = %d, want 0 (one nudge per gap)", sent)
	}
}

// A reminder that already fired before the drop-off fires again for the gap
// that opens at pick-up: the pick-up is newer than the last nudge.
func TestPickUpStartsANewGapAfterAnEarlierNudge(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "d2")
	addReminder(t, a, cookie, map[string]any{"kind": "diaper", "mode": "since_last", "intervalMin": 120, "tz": "UTC"})

	day := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	logAt(t, a, cookie, "/api/diapers", map[string]any{"babyId": babyID, "time": day.Add(5 * time.Hour).Format(time.RFC3339), "type": "wet"})
	if sent := run(t, a, day.Add(7*time.Hour+30*time.Minute)); sent != 1 {
		t.Fatalf("sent before drop-off = %d, want 1", sent)
	}
	id := dropOff(t, a, cookie, babyID, day.Add(8*time.Hour))
	pickUp(t, a, cookie, id, day.Add(15*time.Hour))
	if sent := run(t, a, day.Add(17*time.Hour+15*time.Minute)); sent != 1 {
		t.Fatalf("sent 2 h 15 min after pick-up = %d, want 1", sent)
	}
}

// A family-wide reminder (no baby) holds while ANY baby is there; one about
// the sibling at home does not; pump and medicine are never held.
func TestDaycareHoldIsPerBabyAndPerKind(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	nora := a.NewBaby(familyID, "Nora")
	emil := a.NewBaby(familyID, "Emil")
	userID := userIDByEmail(t, a, "parent@example.com")
	subscribe(t, a, cookie, "d3")

	day := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	morning := day.Add(7 * time.Hour).Format(time.RFC3339)
	for _, baby := range []string{nora, emil} {
		logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": baby, "time": morning, "type": "bottle", "amountMl": 120})
	}
	logAt(t, a, cookie, "/api/pumps", map[string]any{"babyId": nora, "time": morning, "amountMl": 80})
	logAt(t, a, cookie, "/api/medicine", map[string]any{"babyId": nora, "time": morning, "name": "D-vitamin"})
	dropOff(t, a, cookie, nora, day.Add(8*time.Hour))

	noon := day.Add(12 * time.Hour)
	for _, c := range []struct {
		name     string
		reminder map[string]any
		want     int
	}{
		{"feed, the baby at daycare", map[string]any{"kind": "feed", "babyId": nora}, 0},
		{"feed, the whole family", map[string]any{"kind": "feed"}, 0},
		{"feed, the sibling at home", map[string]any{"kind": "feed", "babyId": emil}, 1},
		{"pump", map[string]any{"kind": "pump"}, 1},
		{"medicine", map[string]any{"kind": "medicine", "label": "D-vitamin", "babyId": nora}, 1},
	} {
		body := map[string]any{"mode": "since_last", "intervalMin": 180, "tz": "UTC"}
		for k, v := range c.reminder {
			body[k] = v
		}
		id := addReminder(t, a, cookie, body)
		before := a.Push.Count(userID)
		run(t, a, noon)
		if got := a.Push.Count(userID) - before; got != c.want {
			t.Errorf("%s: sent = %d, want %d", c.name, got, c.want)
		}
		if res := a.Do(http.MethodDelete, "/api/reminders/"+id, cookie, nil); res.Status != http.StatusOK {
			t.Fatalf("delete reminder: %d %s", res.Status, res.Raw)
		}
	}
}

// A fixed-time feed reminder is the parent's own clock: never held.
func TestDaycareDoesNotHoldFixedTimeReminders(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "d4")
	addReminder(t, a, cookie, map[string]any{"kind": "feed", "mode": "at_time", "atMinute": 12 * 60, "tz": "UTC"})
	day := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	dropOff(t, a, cookie, babyID, day.Add(8*time.Hour))
	if sent := run(t, a, day.Add(12*time.Hour+5*time.Minute)); sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
}

// A snooze that comes due after the drop-off is dropped, not held: by
// pick-up it has been answered.
func TestSnoozeIsDroppedAtDaycare(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 16, 7, 50, 0, 0, time.UTC)
	cookie, babyID, _, first := feedReminderDue(t, a, now, feedEvery3h)
	tapSnooze(t, a, first, now.Add(time.Minute))
	id := dropOff(t, a, cookie, babyID, now.Add(10*time.Minute))

	if sent := runSnoozes(t, a, now.Add(15*time.Minute)); sent != 0 {
		t.Fatalf("snooze sent at daycare = %d, want 0", sent)
	}
	pickUp(t, a, cookie, id, now.Add(8*time.Hour))
	if sent := runSnoozes(t, a, now.Add(8*time.Hour+15*time.Minute)); sent != 0 {
		t.Fatalf("snooze sent after pick-up = %d, want 0 (dropped, one shot)", sent)
	}
}
