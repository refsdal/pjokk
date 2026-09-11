package api_test

// "This occurrence only" (docs/superpowers/specs/2026-09-11-calendar-occurrence-exceptions-design.md):
// deleting one occurrence skips it; editing one detaches it into a
// standalone event.

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Mondays 10:00 Oslo through March 2026: the 2nd, 9th, 16th, 23rd, 30th —
// the last after the clocks go forward on the 29th, so 08:00Z, not 09:00Z.
var (
	seriesStart = time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)
	seriesUntil = time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)
	week        = 7 * 24 * time.Hour
)

func occurrenceURL(id string, occ time.Time) string {
	return "/api/calendar/events/" + id + "?occurrence=" + url.QueryEscape(occ.Format(time.RFC3339))
}

func createWeekly(t *testing.T, a *testrig.AppRig, cookie string, extra map[string]any) string {
	t.Helper()
	body := map[string]any{
		"title": "Physio", "category": "doctor",
		"startTime": seriesStart.Format(time.RFC3339), "durationMin": 45,
		"recurrence": "weekly", "recurrenceUntil": seriesUntil.Format(time.RFC3339),
	}
	for k, v := range extra {
		body[k] = v
	}
	res := a.Do(http.MethodPost, "/api/calendar/events", cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("create = %d %s", res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	return id
}

// march lists March 2026 as "title@start".
func march(t *testing.T, a *testrig.AppRig, cookie string) []string {
	t.Helper()
	res := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(
		time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)), cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("list = %d %s", res.Status, res.Raw)
	}
	var out []string
	for _, e := range res.JSON {
		m, _ := e.(map[string]any)
		out = append(out, m["title"].(string)+"@"+m["startTime"].(string))
	}
	return out
}

func TestDeleteOneOccurrenceSkipsItEverywhere(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	id := createWeekly(t, a, cookie, nil)
	second := seriesStart.Add(week)

	if res := a.Do(http.MethodDelete, occurrenceURL(id, second), cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete one = %d %s", res.Status, res.Raw)
	}
	want := "Physio@2026-03-02T09:00:00Z Physio@2026-03-16T09:00:00Z Physio@2026-03-23T09:00:00Z Physio@2026-03-30T08:00:00Z"
	if got := strings.Join(march(t, a, cookie), " "); got != want {
		t.Errorf("March = %s, want %s", got, want)
	}

	key := a.CreateAPIKey(familyID, userIDByEmail(t, a, "parent@example.com"))
	feed := a.Do(http.MethodGet, "/api/calendar.ics?key="+key, "", nil)
	if feed.Status != http.StatusOK || !strings.Contains(string(feed.Raw), "EXDATE;TZID=Europe/Oslo:20260309T100000") {
		t.Errorf("feed = %d, want the skipped occurrence as an EXDATE:\n%s", feed.Status, feed.Raw)
	}

	for name, occ := range map[string]time.Time{
		"already skipped": second,
		"off the rule":    seriesStart.Add(week + time.Hour),
		"past Until":      seriesStart.Add(5 * week),
	} {
		res := a.Do(http.MethodDelete, occurrenceURL(id, occ), cookie, nil)
		if res.Status != http.StatusBadRequest || res.JSON["code"] != "NOT_AN_OCCURRENCE" {
			t.Errorf("delete %s = %d %s, want 400 NOT_AN_OCCURRENCE", name, res.Status, res.Raw)
		}
	}

	oneOff := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title": "Vaccine", "startTime": seriesStart.Format(time.RFC3339),
	})
	oneOffID, _ := oneOff.JSON["id"].(string)
	if res := a.Do(http.MethodDelete, occurrenceURL(oneOffID, seriesStart), cookie, nil); res.Status != http.StatusBadRequest {
		t.Errorf("an occurrence of a one-off = %d, want 400", res.Status)
	}
	if res := a.Do(http.MethodDelete, occurrenceURL("no-such-event", seriesStart), cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("an unknown event = %d, want 404", res.Status)
	}
	// Another family's series is not found, like every family-scoped route.
	_, other := a.NewFamily("Berg", "berg@example.com")
	if res := a.Do(http.MethodDelete, occurrenceURL(id, seriesStart), other, nil); res.Status != http.StatusNotFound {
		t.Errorf("another family's occurrence = %d, want 404", res.Status)
	}
}

func TestEditOneOccurrenceDetachesIt(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	baby := a.NewBaby(familyID, "Nora")
	parent := userIDByEmail(t, a, "parent@example.com")
	id := createWeekly(t, a, cookie, map[string]any{
		"babyIds": []string{baby}, "assigneeUserIds": []string{parent}, "remindMinutesBefore": 60,
	})
	third := seriesStart.Add(2 * week)
	moved := third.Add(2 * time.Hour)

	res := a.Do(http.MethodPatch, occurrenceURL(id, third), cookie, map[string]any{
		"title": "Physio (moved)", "startTime": moved.Format(time.RFC3339),
		// Ignored for a single occurrence: it does not repeat.
		"recurrence": "daily",
	})
	if res.Status != http.StatusOK {
		t.Fatalf("edit one = %d %s", res.Status, res.Raw)
	}
	if res.JSON["id"] == id || res.JSON["recurrence"] != "none" || res.JSON["title"] != "Physio (moved)" ||
		res.JSON["startTime"] != moved.Format(time.RFC3339) || res.JSON["remindMinutesBefore"] != float64(60) ||
		res.JSON["durationMin"] != float64(45) || res.JSON["category"] != "doctor" {
		t.Errorf("detached = %v", res.JSON)
	}
	if babies, _ := res.JSON["babies"].([]any); len(babies) != 1 {
		t.Errorf("detached babies = %v, want the series' baby", res.JSON["babies"])
	}
	if assignees, _ := res.JSON["assignees"].([]any); len(assignees) != 1 {
		t.Errorf("detached assignees = %v, want the series' assignee", res.JSON["assignees"])
	}

	want := "Physio@2026-03-02T09:00:00Z Physio@2026-03-09T09:00:00Z Physio (moved)@2026-03-16T11:00:00Z Physio@2026-03-23T09:00:00Z Physio@2026-03-30T08:00:00Z"
	if got := strings.Join(march(t, a, cookie), " "); got != want {
		t.Errorf("March = %s, want %s", got, want)
	}
	// That occurrence has left the series: it cannot be edited as one again.
	if again := a.Do(http.MethodPatch, occurrenceURL(id, third), cookie, map[string]any{"title": "x"}); again.Status != http.StatusBadRequest {
		t.Errorf("editing a detached occurrence again = %d, want 400", again.Status)
	}
}

// Editing the whole series keeps its skips unless its occurrences move.
func TestSeriesEditsKeepSkipsUnlessTheSeriesMoves(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	id := createWeekly(t, a, cookie, nil)
	if res := a.Do(http.MethodDelete, occurrenceURL(id, seriesStart.Add(week)), cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete one = %d %s", res.Status, res.Raw)
	}

	// The sheet sends startTime on every save; an unchanged one is no move.
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{
		"title": "Swim", "startTime": seriesStart.Format(time.RFC3339), "recurrence": "weekly",
	}); res.Status != http.StatusOK {
		t.Fatalf("rename = %d %s", res.Status, res.Raw)
	}
	if got := march(t, a, cookie); len(got) != 4 || got[1] != "Swim@2026-03-16T09:00:00Z" {
		t.Errorf("after a rename March = %v, want the skip kept", got)
	}

	// An hour later every Monday: new occurrences, and the old skip goes.
	if res := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{
		"startTime": seriesStart.Add(time.Hour).Format(time.RFC3339),
	}); res.Status != http.StatusOK {
		t.Fatalf("move = %d %s", res.Status, res.Raw)
	}
	if got := march(t, a, cookie); len(got) != 5 || got[1] != "Swim@2026-03-09T10:00:00Z" {
		t.Errorf("after a move March = %v, want all five Mondays back", got)
	}
}
