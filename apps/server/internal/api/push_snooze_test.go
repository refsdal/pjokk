package api_test

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// POST /api/push/snooze (push_snooze.go): public, with the notification's
// signed token as its only credential. The job that sends the snoozed
// reminder again is internal/jobs/snooze_test.go.

func snoozeURL(token string) string {
	return "/api/push/snooze?t=" + url.QueryEscape(token)
}

func TestSnoozePushStoresOneSnoozePerNotification(t *testing.T) {
	a := testrig.App(t)
	userID := a.SignUp("Rig admin", "parent@example.com")
	familyID, err := a.Deps.Auth.CreateFamily(context.Background(), userID, "Hansen")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	sent := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	a.SetNow(sent.Add(3 * time.Minute))
	token := push.SignSnooze(a.Deps.SnoozeKey, push.SnoozeClaims{
		Source: push.SnoozeReminder, ID: "reminder-1", UserID: userID, FamilyID: familyID, SentAt: sent,
	})

	// No cookie: the token is enough. A second tap replaces the first.
	for i := 0; i < 2; i++ {
		res := a.Do(http.MethodPost, snoozeURL(token), "", nil)
		if res.Status != http.StatusOK || res.JSON["ok"] != true {
			t.Fatalf("tap %d: status %d, body %s", i+1, res.Status, res.Raw)
		}
	}
	var n int
	var due time.Time
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT count(*), max("due_at") FROM "push_snooze" WHERE "user_id" = $1 AND "family_id" = $2 AND "source_id" = 'reminder-1'`,
		userID, familyID).Scan(&n, &due); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("rows = %d, want 1", n)
	}
	if want := sent.Add(15 * time.Minute); !due.Equal(want) {
		t.Errorf("due_at = %v, want %v (15 min after the notification, not the tap)", due, want)
	}
}

func TestSnoozePushRejectsAnInvalidToken(t *testing.T) {
	a := testrig.App(t)
	userID := a.SignUp("Rig admin", "parent@example.com")
	familyID, err := a.Deps.Auth.CreateFamily(context.Background(), userID, "Hansen")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	a.SetNow(now)
	claims := push.SnoozeClaims{Source: push.SnoozeReminder, ID: "reminder-1", UserID: userID, FamilyID: familyID, SentAt: now}
	stale := claims
	stale.SentAt = now.Add(-13 * time.Hour)
	gone := claims
	gone.UserID = "no-such-user"

	cases := map[string]string{
		"garbage":      snoozeURL("garbage"),
		"another key":  snoozeURL(push.SignSnooze([32]byte{1}, claims)),
		"expired":      snoozeURL(push.SignSnooze(a.Deps.SnoozeKey, stale)),
		"user deleted": snoozeURL(push.SignSnooze(a.Deps.SnoozeKey, gone)),
	}
	for name, path := range cases {
		res := a.Do(http.MethodPost, path, "", nil)
		if res.Status != http.StatusBadRequest || res.JSON["code"] != "INVALID_TOKEN" {
			t.Errorf("%s: status %d, body %s, want 400 INVALID_TOKEN", name, res.Status, res.Raw)
		}
	}
	if res := a.Do(http.MethodPost, "/api/push/snooze", "", nil); res.Status != http.StatusBadRequest {
		t.Errorf("no token: status %d, want 400", res.Status)
	}
	var n int
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT count(*) FROM "push_snooze"`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("rows = %d, want 0", n)
	}
}
