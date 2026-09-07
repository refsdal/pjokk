package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #52: GET /api/calendar.ics — a subscription feed authenticated by
// a pjk_ key in the query string, series as RRULEs.
func TestCalendarICSFeed(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	var userID string
	if err := a.Deps.Pool.QueryRow(context.Background(), `SELECT "id" FROM "users" WHERE "email" = $1`, "parent@example.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	token := a.CreateAPIKey(familyID, userID)

	until := time.Date(2026, 6, 1, 22, 0, 0, 0, time.UTC)
	a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Physio; weekly, with Nora", "category": "doctor", "location": "Helsestasjonen",
		"startTime": time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC).Format(time.RFC3339), "durationMin": 45,
		"remindMinutesBefore": 60, "recurrence": "biweekly", "recurrenceUntil": until.Format(time.RFC3339),
		"babyIds": []string{babyID},
	})
	a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Grandma visits", "startTime": time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC).Format(time.RFC3339), "allDay": true,
	})
	// Another family's event must not appear.
	_, otherCookie := a.NewFamily("Berg", "other@example.com")
	a.Do(http.MethodPost, "/api/calendar/events", otherCookie, map[string]any{
		"title": "Not yours", "startTime": time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC).Format(time.RFC3339),
	})

	res := a.DoRequest(httptest.NewRequest(http.MethodGet, "/api/calendar.ics?key="+token, nil))
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d %s", res.Status, res.Raw)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/calendar") {
		t.Errorf("content-type = %q", ct)
	}
	body := string(res.Raw)
	for _, want := range []string{
		"BEGIN:VCALENDAR\r\n", "TZID:Europe/Oslo", "BEGIN:VEVENT",
		"DTSTART;TZID=Europe/Oslo:20260302T100000", "DTEND;TZID=Europe/Oslo:20260302T104500",
		"RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20260601T220000Z",
		"SUMMARY:Physio\\; weekly\\, with Nora", "LOCATION:Helsestasjonen", "DESCRIPTION:Nora",
		"TRIGGER:-PT60M", "DTSTART;VALUE=DATE:20260314", "SUMMARY:Grandma visits", "END:VCALENDAR",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("feed lacks %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "Not yours") {
		t.Errorf("another family's event leaked into the feed")
	}
	for _, l := range strings.Split(body, "\r\n") {
		if len(l) > 75 {
			t.Errorf("unfolded line over 75 octets: %q", l)
		}
	}

	// No key: not authenticated. A bogus key: invalid.
	if res := a.DoRequest(httptest.NewRequest(http.MethodGet, "/api/calendar.ics", nil)); res.Status != http.StatusUnauthorized {
		t.Errorf("no key = %d, want 401", res.Status)
	}
	if res := a.DoRequest(httptest.NewRequest(http.MethodGet, "/api/calendar.ics?key=pjk_nope", nil)); res.Status != http.StatusUnauthorized {
		t.Errorf("bad key = %d, want 401", res.Status)
	}
	// The session cookie works too (the app's own preview).
	if res := a.Do(http.MethodGet, "/api/calendar.ics", cookie, nil); res.Status != http.StatusOK {
		t.Errorf("cookie = %d, want 200", res.Status)
	}
}
