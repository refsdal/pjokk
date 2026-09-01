package jobs_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

const (
	calSubP256dh = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM"
	calSubAuth   = "tBHItJI5svbpez7KI4CCXg"
)

func subscribePush(t *testing.T, a *testrig.AppRig, cookie, endpoint string) {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, map[string]any{
		"endpoint": endpoint,
		"p256dh":   calSubP256dh,
		"auth":     calSubAuth,
	})
	if res.Status != http.StatusOK {
		t.Fatalf("subscribe %q status = %d, body %s", endpoint, res.Status, res.Raw)
	}
}

func createCalendarEvent(t *testing.T, a *testrig.AppRig, cookie string, body map[string]any) string {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/calendar/events", cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("create event status = %d, body %s", res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	if id == "" {
		t.Fatalf("create event: no id in response %s", res.Raw)
	}
	return id
}

func userIDByEmail(t *testing.T, a *testrig.AppRig, email string) string {
	t.Helper()
	var id string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "users" WHERE "email" = $1`, email).Scan(&id); err != nil {
		t.Fatalf("userIDByEmail(%q): %v", email, err)
	}
	return id
}

// Ports calendar-reminders.test.ts's "fires once inside the window, to all
// members when unassigned".
func TestCalendarRemindersFireOnceToAllMembersWhenUnassigned(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	subscribePush(t, a, cookie, "https://fcm.googleapis.com/cal/admin")

	otherID := a.SignUp("Other parent", "other@example.com")
	otherCookie := a.AddMember(familyID, otherID, auth.RoleMember, "other@example.com")
	subscribePush(t, a, otherCookie, "https://fcm.googleapis.com/cal/other")

	now := time.Now().Truncate(time.Second)
	createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Checkup",
		"startTime":           now.Add(30 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})

	d := depsFor(a)
	ctx := context.Background()

	// Inside the lead window: one push per member, then silence.
	sent, err := jobs.RunCalendarReminders(ctx, d, now)
	if err != nil {
		t.Fatalf("RunCalendarReminders: %v", err)
	}
	if sent != 2 {
		t.Fatalf("sent = %d, want 2", sent)
	}
	if got := a.Push.Count(adminID); got != 1 {
		t.Errorf("admin delivery count = %d, want 1", got)
	}
	if got := a.Push.Count(otherID); got != 1 {
		t.Errorf("other member delivery count = %d, want 1", got)
	}

	sentAgain, err := jobs.RunCalendarReminders(ctx, d, now.Add(15*time.Minute))
	if err != nil {
		t.Fatalf("RunCalendarReminders (repeat): %v", err)
	}
	if sentAgain != 0 {
		t.Fatalf("sent (repeat) = %d, want 0", sentAgain)
	}
}

// Ports "targets only assignees when set".
func TestCalendarRemindersTargetOnlyAssigneesWhenSet(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	subscribePush(t, a, cookie, "https://fcm.googleapis.com/cal2/admin")

	otherID := a.SignUp("Other parent", "other2@example.com")
	otherCookie := a.AddMember(familyID, otherID, auth.RoleMember, "other2@example.com")
	subscribePush(t, a, otherCookie, "https://fcm.googleapis.com/cal2/other")

	now := time.Now().Truncate(time.Second)
	createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Babysitting",
		"startTime":           now.Add(30 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
		"assigneeUserIds":     []string{otherID},
	})

	d := depsFor(a)
	sent, err := jobs.RunCalendarReminders(context.Background(), d, now)
	if err != nil {
		t.Fatalf("RunCalendarReminders: %v", err)
	}
	if sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
	if got := a.Push.Count(otherID); got != 1 {
		t.Errorf("assignee delivery count = %d, want 1", got)
	}
	if got := a.Push.Count(adminID); got != 0 {
		t.Errorf("non-assignee delivery count = %d, want 0", got)
	}
}

// Ports "not yet due -> nothing; long-past -> latched silently".
func TestCalendarRemindersGraceLatchesLongPastEventsSilently(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	subscribePush(t, a, cookie, "https://fcm.googleapis.com/cal3/admin")

	now := time.Now().Truncate(time.Second)
	const hour = time.Hour

	notDueID := createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Far future",
		"startTime":           now.Add(10 * hour).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})
	pastID := createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Missed",
		"startTime":           now.Add(hour).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})

	d := depsFor(a)
	ctx := context.Background()

	// Simulate downtime: the sweep first runs 2h after the past event started.
	sent, err := jobs.RunCalendarReminders(ctx, d, now.Add(3*hour))
	if err != nil {
		t.Fatalf("RunCalendarReminders: %v", err)
	}
	if sent != 0 {
		t.Fatalf("sent = %d, want 0", sent)
	}
	if got := a.Push.Count(adminID); got != 0 {
		t.Errorf("delivery count = %d, want 0 (latched silently)", got)
	}

	remindedAt := calendarEventRemindedAt(t, a, pastID)
	if remindedAt == nil {
		t.Errorf("past event's reminded_at is nil, want latched")
	}
	notDueRemindedAt := calendarEventRemindedAt(t, a, notDueID)
	if notDueRemindedAt != nil {
		t.Errorf("not-due event's reminded_at = %v, want nil", *notDueRemindedAt)
	}
}

func calendarEventRemindedAt(t *testing.T, a *testrig.AppRig, id string) *time.Time {
	t.Helper()
	var remindedAt *time.Time
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "reminded_at" FROM "calendar_event" WHERE "id" = $1`, id).Scan(&remindedAt); err != nil {
		t.Fatalf("read reminded_at for %q: %v", id, err)
	}
	return remindedAt
}

// Ports "formats the reminder clock in Europe/Oslo, not workerd's UTC
// default" — the direct clockFmt assertions, plus one round trip.
func TestFormatOsloClock(t *testing.T) {
	// 2026-08-25T12:00:00Z is during CEST (UTC+2) -> 14:00 Oslo-local.
	summer := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	if got := jobs.FormatOsloClock(summer); got != "14:00" {
		t.Errorf("FormatOsloClock(%v) = %q, want %q", summer, got, "14:00")
	}

	// Winter (CET, UTC+1) sanity check too.
	winter := time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)
	if got := jobs.FormatOsloClock(winter); got != "13:00" {
		t.Errorf("FormatOsloClock(%v) = %q, want %q", winter, got, "13:00")
	}
}

func TestCalendarRemindersRoundTripDeliversExactlyOncePerDueEvent(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	subscribePush(t, a, cookie, "https://fcm.googleapis.com/cal4/admin")

	now := time.Now().Truncate(time.Second)
	createCalendarEvent(t, a, cookie, map[string]any{
		"title":               "Oslo clock check",
		"startTime":           now.Add(30 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})

	d := depsFor(a)
	sent, err := jobs.RunCalendarReminders(context.Background(), d, now)
	if err != nil {
		t.Fatalf("RunCalendarReminders: %v", err)
	}
	if sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
}
