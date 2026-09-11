package jobs_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Pushes are written in the recipient's language (users.language, 00018;
// internal/push/text.go). Everything else in this package runs as the
// default, English.

func speaksNorwegian(t *testing.T, a *testrig.AppRig, cookie string) {
	t.Helper()
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"language": "nb"}); res.Status != http.StatusOK {
		t.Fatalf("PATCH /api/me language: %d %s", res.Status, res.Raw)
	}
}

func actionTitles(p push.PushPayload) []string {
	var out []string
	for _, a := range p.Actions {
		out = append(out, a.Title)
	}
	return out
}

func TestReminderAndItsSnoozeAreInThePersonsLanguage(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	userID := userIDByEmail(t, a, "parent@example.com")
	speaksNorwegian(t, a, cookie)
	addReminder(t, a, cookie, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC", "babyId": babyID})
	addReminder(t, a, cookie, map[string]any{"kind": "diaper", "mode": "at_time", "atMinute": 12 * 60, "tz": "UTC"})
	logAt(t, a, cookie, "/api/feeds", map[string]any{"babyId": babyID, "time": now.Add(-4 * time.Hour).Format(time.RFC3339), "type": "bottle", "amountMl": 100})

	if sent := run(t, a, now); sent != 2 {
		t.Fatalf("sent = %d, want 2", sent)
	}
	bodies := map[string][]string{}
	var feed push.PushPayload
	for _, p := range a.Push.Sent(userID) {
		bodies[p.Body] = actionTitles(p)
		if p.Body == "Nora: Ikke noe måltid logget på 4 t" {
			feed = p
		}
	}
	want := map[string][]string{
		"Nora: Ikke noe måltid logget på 4 t": {"Logg måltid", "Utsett 15 min"},
		"Påminnelse: bleie":                   {"Logg bleie", "Utsett 15 min"},
	}
	for body, titles := range want {
		got, ok := bodies[body]
		if !ok || len(got) != len(titles) || got[0] != titles[0] || got[1] != titles[1] {
			t.Errorf("push %q: buttons %v (present %v), want %v; all: %v", body, got, ok, titles, bodies)
		}
	}

	tapSnooze(t, a, feed, now.Add(time.Minute))
	if sent := runSnoozes(t, a, now.Add(15*time.Minute)); sent != 1 {
		t.Fatalf("snoozed sent = %d, want 1", sent)
	}
	got := a.Push.Sent(userID)
	again := got[len(got)-1]
	if again.Body != "Nora: Ikke noe måltid logget på 4 t" || actionTitles(again)[1] != "Utsett 15 min" {
		t.Errorf("snoozed push = %+v", again)
	}
}

func TestCalendarSnoozeButtonIsInEachMembersLanguage(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	otherID := a.SignUp("Other parent", "other@example.com")
	otherCookie := a.AddMember(familyID, otherID, auth.RoleMember, "other@example.com")
	speaksNorwegian(t, a, otherCookie)

	now := time.Date(2026, 3, 16, 9, 0, 0, 0, time.UTC)
	createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Helsestasjon",
		"startTime":           now.Add(30 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})
	if sent, err := jobs.RunCalendarReminders(context.Background(), depsFor(a), now); err != nil || sent != 2 {
		t.Fatalf("RunCalendarReminders = %d, %v; want 2", sent, err)
	}
	if got := actionTitles(a.Push.Sent(adminID)[0]); got[0] != "Snooze 15 min" {
		t.Errorf("admin (English) button = %v", got)
	}
	if got := actionTitles(a.Push.Sent(otherID)[0]); got[0] != "Utsett 15 min" {
		t.Errorf("member (Norwegian) button = %v", got)
	}
	// The event's title is the family's own words: never translated.
	if a.Push.Sent(otherID)[0].Body != "Helsestasjon · 10:30" {
		t.Errorf("body = %q", a.Push.Sent(otherID)[0].Body)
	}
}
