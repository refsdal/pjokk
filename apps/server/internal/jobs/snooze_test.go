package jobs_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// "Snooze 15 min" (jobs/snooze.go, api/push_snooze.go): the button on every
// reminder notification, and the frequent job sending the reminder again.

func snoozeActionOf(t *testing.T, p push.PushPayload) push.PushAction {
	t.Helper()
	for _, a := range p.Actions {
		if a.Action == "snooze" {
			if !a.Post || !strings.HasPrefix(a.URL, "/api/push/snooze?t=") {
				t.Fatalf("snooze action = %+v, want a background POST to /api/push/snooze", a)
			}
			return a
		}
	}
	t.Fatalf("payload %+v has no snooze action", p)
	return push.PushAction{}
}

// tapSnooze does what the service worker does with the button, at a moment
// on the rig's clock, with no session.
func tapSnooze(t *testing.T, a *testrig.AppRig, p push.PushPayload, at time.Time) {
	t.Helper()
	a.SetNow(at)
	defer a.SetNow(time.Time{})
	if res := a.Do(http.MethodPost, snoozeActionOf(t, p).URL, "", nil); res.Status != http.StatusOK {
		t.Fatalf("snooze: status %d, body %s", res.Status, res.Raw)
	}
}

func runSnoozes(t *testing.T, a *testrig.AppRig, now time.Time) int {
	t.Helper()
	sent, err := jobs.RunSnoozes(context.Background(), depsFor(a), now)
	if err != nil {
		t.Fatalf("RunSnoozes: %v", err)
	}
	return sent
}

// feedReminderDue sets up a family whose feed reminder fires at now, and
// returns the one notification it sent.
func feedReminderDue(t *testing.T, a *testrig.AppRig, now time.Time, reminder map[string]any) (cookie, babyID, userID string, p push.PushPayload) {
	t.Helper()
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID = a.NewBaby(familyID, "Nora")
	userID = userIDByEmail(t, a, "parent@example.com")
	addReminder(t, a, cookie, reminder)
	logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": now.Add(-4 * time.Hour).Format(time.RFC3339), "type": "bottle", "amountMl": 100})
	if sent := run(t, a, now); sent != 1 {
		t.Fatalf("reminder sent = %d, want 1", sent)
	}
	return cookie, babyID, userID, a.Push.Sent(userID)[0]
}

var feedEvery3h = map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC"}

func TestSnoozedReminderComesBackOneTickLater(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	_, _, userID, first := feedReminderDue(t, a, now, feedEvery3h)
	if first.Actions[0].Action != "log" {
		t.Errorf("first action = %+v, want the Log feed button kept first", first.Actions[0])
	}

	tapSnooze(t, a, first, now.Add(4*time.Minute))
	// Due 15 minutes after the notification, whenever the tap came; the
	// tick before is too early.
	if sent := runSnoozes(t, a, now.Add(10*time.Minute)); sent != 0 {
		t.Fatalf("at +10 min sent = %d, want 0", sent)
	}
	// The tick lands a moment after the quarter hour, or a moment before.
	if sent := runSnoozes(t, a, now.Add(14*time.Minute)); sent != 1 {
		t.Fatalf("at +14 min sent = %d, want 1", sent)
	}
	got := a.Push.Sent(userID)
	if len(got) != 2 {
		t.Fatalf("deliveries = %d, want 2", len(got))
	}
	again := got[1]
	if again.Body != "No feed logged for 4 h" || again.URL != "/home" {
		t.Errorf("snoozed payload = %+v", again)
	}
	snoozeActionOf(t, again) // snoozable again
	if again.Actions[0].Action != "log" {
		t.Errorf("snoozed actions = %+v, want Log feed first", again.Actions)
	}
	// One shot.
	if sent := runSnoozes(t, a, now.Add(30*time.Minute)); sent != 0 {
		t.Errorf("at +30 min sent = %d, want 0", sent)
	}
}

func TestSnoozeIsCancelledByLoggingTheFeed(t *testing.T) {
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	for name, fedAt := range map[string]time.Time{
		"logged now":                    now.Add(5 * time.Minute),
		"logged with the 15 m ago chip": now.Add(-10 * time.Minute),
	} {
		t.Run(name, func(t *testing.T) {
			a := testrig.App(t)
			cookie, babyID, userID, first := feedReminderDue(t, a, now, feedEvery3h)
			tapSnooze(t, a, first, now.Add(time.Minute))
			logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": fedAt.Format(time.RFC3339), "type": "bottle", "amountMl": 100})
			if sent := runSnoozes(t, a, now.Add(15*time.Minute)); sent != 0 {
				t.Fatalf("sent = %d, want 0", sent)
			}
			if n := a.Push.Count(userID); n != 1 {
				t.Errorf("deliveries = %d, want 1", n)
			}
			// Dropped, not held.
			var rows int
			if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT count(*) FROM "push_snooze"`).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows != 0 {
				t.Errorf("snooze rows = %d, want 0", rows)
			}
		})
	}
}

func TestSnoozeOfADeletedReminderIsDropped(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	cookie, _, userID, first := feedReminderDue(t, a, now, feedEvery3h)
	tapSnooze(t, a, first, now.Add(time.Minute))

	res := a.DoArray(http.MethodGet, "/api/reminders", cookie, nil)
	id, _ := res.JSON[0].(map[string]any)["id"].(string)
	if del := a.Do(http.MethodDelete, "/api/reminders/"+id, cookie, nil); del.Status != http.StatusOK && del.Status != http.StatusNoContent {
		t.Fatalf("delete reminder: status %d, body %s", del.Status, del.Raw)
	}
	if sent := runSnoozes(t, a, now.Add(15*time.Minute)); sent != 0 {
		t.Errorf("sent = %d, want 0", sent)
	}
	if n := a.Push.Count(userID); n != 1 {
		t.Errorf("deliveries = %d, want 1", n)
	}
}

func TestSnoozeWaitsOutQuietHours(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 16, 11, 50, 0, 0, time.UTC)
	quiet := map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC", "quietStart": 12, "quietEnd": 14}
	_, _, userID, first := feedReminderDue(t, a, now, quiet)
	tapSnooze(t, a, first, now.Add(time.Minute))

	if sent := runSnoozes(t, a, now.Add(15*time.Minute)); sent != 0 {
		t.Fatalf("in quiet hours sent = %d, want 0", sent)
	}
	if sent := runSnoozes(t, a, time.Date(2026, 3, 16, 14, 0, 0, 0, time.UTC)); sent != 1 {
		t.Fatalf("after quiet hours sent = %d, want 1 (held, not dropped)", sent)
	}
	if got := a.Push.Sent(userID); len(got) != 2 || got[1].Body != "No feed logged for 6 h" {
		t.Errorf("deliveries = %+v", got)
	}
}

func TestCalendarSnoozeComesBackToTheSnoozerOnly(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	otherID := a.SignUp("Other parent", "other@example.com")
	a.AddMember(familyID, otherID, auth.RoleMember, "other@example.com")

	now := time.Date(2026, 3, 16, 9, 0, 0, 0, time.UTC)
	createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Checkup",
		"startTime":           now.Add(30 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})
	sent, err := jobs.RunCalendarReminders(context.Background(), depsFor(a), now)
	if err != nil || sent != 2 {
		t.Fatalf("RunCalendarReminders = %d, %v; want 2", sent, err)
	}
	// Each person's button is their own.
	adminURL := snoozeActionOf(t, a.Push.Sent(adminID)[0]).URL
	if adminURL == snoozeActionOf(t, a.Push.Sent(otherID)[0]).URL {
		t.Fatal("both members got the same snooze token")
	}

	tapSnooze(t, a, a.Push.Sent(otherID)[0], now.Add(2*time.Minute))
	if sent := runSnoozes(t, a, now.Add(15*time.Minute)); sent != 1 {
		t.Fatalf("snoozed sent = %d, want 1", sent)
	}
	if n := a.Push.Count(adminID); n != 1 {
		t.Errorf("admin deliveries = %d, want 1", n)
	}
	got := a.Push.Sent(otherID)
	if len(got) != 2 {
		t.Fatalf("snoozer deliveries = %d, want 2", len(got))
	}
	// 09:30Z is 10:30 in Oslo in March.
	if got[1].Body != "Checkup · 10:30" || got[1].URL != "/calendar" {
		t.Errorf("snoozed payload = %+v", got[1])
	}
	snoozeActionOf(t, got[1])
	// The calendar's own latch still holds: no second ordinary reminder.
	if sent, _ := jobs.RunCalendarReminders(context.Background(), depsFor(a), now.Add(15*time.Minute)); sent != 0 {
		t.Errorf("calendar reminders re-sent = %d, want 0", sent)
	}
}
