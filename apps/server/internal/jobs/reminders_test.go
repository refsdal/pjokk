package jobs_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Ports push.test.ts's "feed reminders: one nudge per gap, reset by a new
// feed".
func TestRunFeedRemindersOneNudgePerGapResetByNewFeed(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, map[string]any{
		"endpoint": "https://fcm.googleapis.com/sub/remind",
		"p256dh":   "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
		"auth":     "tBHItJI5svbpez7KI4CCXg",
	}); res.Status != http.StatusOK {
		t.Fatalf("subscribe status = %d, body %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 3}); res.Status != http.StatusOK {
		t.Fatalf("set prefs status = %d, body %s", res.Status, res.Raw)
	}

	ctx := context.Background()
	d := depsFor(a)
	now := time.Now().Truncate(time.Second)

	feedAt := func(msAgo time.Duration) {
		t.Helper()
		res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
			"babyId":   babyID,
			"time":     now.Add(-msAgo).Format(time.RFC3339),
			"type":     "bottle",
			"amountMl": 100,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("create feed status = %d, body %s", res.Status, res.Raw)
		}
	}

	// Last feed 2h ago: below the 3h threshold — nothing sent.
	feedAt(2 * time.Hour)
	sent, err := jobs.RunFeedReminders(ctx, d, now)
	if err != nil {
		t.Fatalf("RunFeedReminders: %v", err)
	}
	if sent != 0 {
		t.Fatalf("sent = %d, want 0", sent)
	}

	// 4h later the gap exceeds 3h: exactly one push.
	later := now.Add(4 * time.Hour)
	sent, err = jobs.RunFeedReminders(ctx, d, later)
	if err != nil {
		t.Fatalf("RunFeedReminders: %v", err)
	}
	if sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}

	// Same gap, next cron run: already reminded — silent.
	sent, err = jobs.RunFeedReminders(ctx, d, later.Add(15*time.Minute))
	if err != nil {
		t.Fatalf("RunFeedReminders: %v", err)
	}
	if sent != 0 {
		t.Fatalf("sent (repeat) = %d, want 0", sent)
	}

	// A new feed starts a new gap; once IT exceeds 3h, remind again.
	feedAt(-time.Duration(4.2 * float64(time.Hour))) // logged at now+4.2h
	evenLater := now.Add(8 * time.Hour)
	sent, err = jobs.RunFeedReminders(ctx, d, evenLater)
	if err != nil {
		t.Fatalf("RunFeedReminders: %v", err)
	}
	if sent != 1 {
		t.Fatalf("sent (new gap) = %d, want 1", sent)
	}
}

// Confirms a family that never logged a feed is skipped rather than
// crashing on a NULL max(time).
func TestRunFeedRemindersSkipsFamilyWithNoFeeds(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, map[string]any{
		"endpoint": "https://fcm.googleapis.com/sub/nofeed",
		"p256dh":   "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
		"auth":     "tBHItJI5svbpez7KI4CCXg",
	}); res.Status != http.StatusOK {
		t.Fatalf("subscribe status = %d, body %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 3}); res.Status != http.StatusOK {
		t.Fatalf("set prefs status = %d, body %s", res.Status, res.Raw)
	}

	d := depsFor(a)
	sent, err := jobs.RunFeedReminders(context.Background(), d, time.Now())
	if err != nil {
		t.Fatalf("RunFeedReminders: %v", err)
	}
	if sent != 0 {
		t.Fatalf("sent = %d, want 0 (no feeds ever logged)", sent)
	}
}
