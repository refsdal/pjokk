package jobs_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #51: a reminder's push carries a "log it now" action pointing at
// Home's ?log= deep link; a custom reminder carries none.
func TestRunRemindersCarriesLogAction(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribe(t, a, cookie, "1")
	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	userID, _ := me.JSON["id"].(string)
	if userID == "" {
		userID, _ = me.JSON["userId"].(string)
	}
	if userID == "" {
		t.Fatalf("no user id in /api/me: %s", me.Raw)
	}

	addReminder(t, a, cookie, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC"})
	addReminder(t, a, cookie, map[string]any{"kind": "custom", "mode": "at_time", "atMinute": 12 * 60, "tz": "UTC", "label": "Tummy time"})
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": now.Add(-4 * time.Hour).Format(time.RFC3339), "type": "bottle", "amountMl": 100})

	if sent := run(t, a, now); sent != 2 {
		t.Fatalf("sent = %d, want 2 (the feed gap and the noon custom)", sent)
	}
	payloads := a.Push.Sent(userID)
	if len(payloads) != 2 {
		t.Fatalf("recorded %d payloads, want 2", len(payloads))
	}
	var sawFeed, sawCustom bool
	for _, p := range payloads {
		switch {
		case len(p.Actions) == 1:
			sawFeed = true
			if p.Actions[0].URL != "/home?log=feed" || p.Actions[0].Title != "Log feed" || p.Actions[0].Action != "log" {
				t.Errorf("feed action = %+v, want log / Log feed / /home?log=feed", p.Actions[0])
			}
		case len(p.Actions) == 0:
			sawCustom = true
		default:
			t.Errorf("unexpected actions: %+v", p.Actions)
		}
	}
	if !sawFeed || !sawCustom {
		t.Errorf("payloads = %+v, want one with the feed action and one without", payloads)
	}
}
