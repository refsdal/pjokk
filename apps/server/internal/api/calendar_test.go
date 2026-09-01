package api_test

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Calendar — ports apps/api/test/calendar.test.ts's "calendar scoped
// helpers" and "calendar API" describe blocks. The TS predecessor
// soft-locked event creation behind premium (402 PLAN_REQUIRED); this Go
// port removes that gate entirely (see internal/api/calendar.go's package
// doc comment), so the 402-vs-premium test is replaced by
// TestCreateCalendarEventIsFreeFullCRUD below, asserting the same CRUD
// sequence succeeds with no plan setup at all.
// -----------------------------------------------------------------------

const hour = time.Hour

func futureISO(h time.Duration) string {
	return time.Now().Add(h).UTC().Format(time.RFC3339)
}

func rangeQuery(from, to time.Time) string {
	q := url.Values{}
	q.Set("from", from.UTC().Format(time.RFC3339))
	q.Set("to", to.UTC().Format(time.RFC3339))
	return q.Encode()
}

func TestCreateCalendarEventWithBabiesAndAssigneesHydrates(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	otherID := a.SignUp("Other parent", "other@example.com")
	a.AddMember(familyID, otherID, auth.RoleMember, "other@example.com")

	res := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":               "Doctor checkup",
		"description":         "6-month control",
		"location":            "Legesenteret",
		"category":            "doctor",
		"startTime":           futureISO(24 * hour),
		"allDay":              false,
		"durationMin":         30,
		"remindMinutesBefore": 60,
		"babyIds":             []string{babyID},
		"assigneeUserIds":     []string{otherID},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["title"] != "Doctor checkup" {
		t.Errorf("title = %v, want %q", res.JSON["title"], "Doctor checkup")
	}
	if res.JSON["createdByName"] != "Rig admin" {
		t.Errorf("createdByName = %v, want %q", res.JSON["createdByName"], "Rig admin")
	}
	babies, _ := res.JSON["babies"].([]any)
	if len(babies) != 1 || babies[0].(map[string]any)["id"] != babyID {
		t.Errorf("babies = %v, want one entry for %q", babies, babyID)
	}
	assignees, _ := res.JSON["assignees"].([]any)
	if len(assignees) != 1 || assignees[0].(map[string]any)["userId"] != otherID {
		t.Errorf("assignees = %v, want one entry for %q", assignees, otherID)
	}
}

func TestListCalendarEventsRangeAscendingFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	base := time.Now()

	mk := func(title string, offsetH time.Duration) {
		res := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
			"title":     title,
			"category":  "other",
			"startTime": base.Add(offsetH).UTC().Format(time.RFC3339),
			"allDay":    false,
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("create %q status = %d, body %s", title, res.Status, res.Raw)
		}
	}
	mk("later", 48*hour)
	mk("sooner", 24*hour)
	mk("outside", 24*200*hour)

	// Another family's event in the same window must not leak.
	_, otherCookie := a.NewFamily("Other family", "stranger@example.com")
	if res := a.Do(http.MethodPost, "/api/calendar/events", otherCookie, map[string]any{
		"title":     "not yours",
		"category":  "other",
		"startTime": base.Add(24 * hour).UTC().Format(time.RFC3339),
		"allDay":    false,
	}); res.Status != http.StatusCreated {
		t.Fatalf("other family create status = %d, body %s", res.Status, res.Raw)
	}

	listed := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(base, base.Add(96*hour)), cookie, nil)
	if listed.Status != http.StatusOK {
		t.Fatalf("list status = %d, body %s", listed.Status, listed.Raw)
	}
	if len(listed.JSON) != 2 {
		t.Fatalf("listed = %v, want 2 events", listed.JSON)
	}
	if listed.JSON[0].(map[string]any)["title"] != "sooner" || listed.JSON[1].(map[string]any)["title"] != "later" {
		t.Errorf("listed titles = %v, want [sooner later]", listed.JSON)
	}
}

func TestUpdateCalendarEventReplacesLinkRowsOmittedUntouched(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	baby2ID := a.NewBaby(familyID, "Twin")
	otherID := a.SignUp("Other parent", "other@example.com")
	a.AddMember(familyID, otherID, auth.RoleMember, "other@example.com")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":           "Vaccine",
		"category":        "vaccination",
		"startTime":       futureISO(24 * hour),
		"babyIds":         []string{babyID},
		"assigneeUserIds": []string{otherID},
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	updated := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{
		"title":           "Vaccine (both)",
		"babyIds":         []string{babyID, baby2ID},
		"assigneeUserIds": []string{},
	})
	if updated.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", updated.Status, updated.Raw)
	}
	if updated.JSON["title"] != "Vaccine (both)" {
		t.Errorf("title = %v, want %q", updated.JSON["title"], "Vaccine (both)")
	}
	babies, _ := updated.JSON["babies"].([]any)
	if len(babies) != 2 {
		t.Errorf("babies after replace = %v, want 2", babies)
	}
	assignees, _ := updated.JSON["assignees"].([]any)
	if len(assignees) != 0 {
		t.Errorf("assignees after clearing = %v, want empty", assignees)
	}

	again := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{
		"location": "Helsestasjonen",
	})
	if again.Status != http.StatusOK {
		t.Fatalf("second PATCH status = %d, body %s", again.Status, again.Raw)
	}
	babiesAgain, _ := again.JSON["babies"].([]any)
	if len(babiesAgain) != 2 {
		t.Errorf("babies after omitted-link PATCH = %v, want still 2 (untouched)", babiesAgain)
	}
}

func TestCalendarEventCrossFamilyUpdateDeleteIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":     "Ours",
		"category":  "family",
		"startTime": futureISO(hour),
		"allDay":    true,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	_, otherCookie := a.NewFamily("Other family", "stranger@example.com")
	hijack := a.Do(http.MethodPatch, "/api/calendar/events/"+id, otherCookie, map[string]any{"title": "Hijack"})
	if hijack.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", hijack.Status)
	}
	del := a.Do(http.MethodDelete, "/api/calendar/events/"+id, otherCookie, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	ownDel := a.Do(http.MethodDelete, "/api/calendar/events/"+id, cookie, nil)
	if ownDel.Status != http.StatusOK {
		t.Errorf("own DELETE status = %d, want 200", ownDel.Status)
	}
}

// TestCreateCalendarEventIsFreeFullCRUD replaces the TS predecessor's
// 402-then-premium test: creation needs no plan at all on this port.
func TestCreateCalendarEventIsFreeFullCRUD(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":       "Checkup",
		"category":    "doctor",
		"startTime":   futureISO(48 * hour),
		"durationMin": 30,
		"babyIds":     []string{babyID},
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s, want 201 (free — no plan gate)", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)
	babies, _ := created.JSON["babies"].([]any)
	if len(babies) != 1 || babies[0].(map[string]any)["id"] != babyID {
		t.Errorf("babies = %v, want one entry for %q", babies, babyID)
	}
	if created.JSON["allDay"] != false {
		t.Errorf("allDay = %v, want false", created.JSON["allDay"])
	}

	list := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(time.Now(), time.Now().Add(90*24*hour)), cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("list status = %d, len = %d, body %s", list.Status, len(list.JSON), list.Raw)
	}

	patched := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"title": "Checkup (moved)"})
	if patched.Status != http.StatusOK {
		t.Errorf("PATCH status = %d, want 200", patched.Status)
	}
	removed := a.Do(http.MethodDelete, "/api/calendar/events/"+id, cookie, nil)
	if removed.Status != http.StatusOK {
		t.Errorf("DELETE status = %d, want 200", removed.Status)
	}
}

func TestCreateCalendarEventDedupesBabyIds(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":     "Checkup",
		"startTime": futureISO(48 * hour),
		"babyIds":   []string{babyID, babyID},
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", created.Status, created.Raw)
	}
	babies, _ := created.JSON["babies"].([]any)
	if len(babies) != 1 {
		t.Errorf("babies = %v, want deduped to 1", babies)
	}
}

func TestCreateCalendarEventRejectsForeignBabyAndAssignee(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Hansen", "parent@example.com")
	familyB, _ := a.NewFamily("Other family", "other@example.com")
	theirBabyID := a.NewBaby(familyB, "Their baby")
	theirUserID := a.SignUp("Their user", "theiruser@example.com")
	a.AddMember(familyB, theirUserID, auth.RoleMember, "theiruser@example.com")

	foreignBaby := a.Do(http.MethodPost, "/api/calendar/events", cookieA, map[string]any{
		"title":     "X",
		"startTime": futureISO(hour),
		"babyIds":   []string{theirBabyID},
	})
	if foreignBaby.Status != http.StatusBadRequest {
		t.Fatalf("foreign baby status = %d, body %s, want 400", foreignBaby.Status, foreignBaby.Raw)
	}
	if foreignBaby.JSON["code"] != "INVALID_REFERENCE" {
		t.Errorf("code = %v, want INVALID_REFERENCE", foreignBaby.JSON["code"])
	}

	foreignAssignee := a.Do(http.MethodPost, "/api/calendar/events", cookieA, map[string]any{
		"title":           "X",
		"startTime":       futureISO(hour),
		"assigneeUserIds": []string{theirUserID},
	})
	if foreignAssignee.Status != http.StatusBadRequest {
		t.Errorf("foreign assignee status = %d, body %s, want 400", foreignAssignee.Status, foreignAssignee.Raw)
	}
}

func TestCalendarEventRangeValidation(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	from := time.Now().Add(2 * hour)
	to := time.Now().Add(hour)
	inverted := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(from, to), cookie, nil)
	if inverted.Status != http.StatusBadRequest {
		t.Errorf("inverted range status = %d, want 400", inverted.Status)
	}

	tooWide := a.DoArray(http.MethodGet, "/api/calendar/events?"+rangeQuery(time.Now(), time.Now().Add(367*24*hour)), cookie, nil)
	if tooWide.Status != http.StatusBadRequest {
		t.Errorf("367-day range status = %d, want 400", tooWide.Status)
	}
}

func TestCalendarEventAllDayCreateNullsDuration(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":               "Visit",
		"startTime":           futureISO(24 * hour),
		"allDay":              true,
		"durationMin":         60,
		"remindMinutesBefore": 60,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["durationMin"] != nil {
		t.Errorf("durationMin = %v, want nil (all-day nulls it)", created.JSON["durationMin"])
	}
}

// Ports the TS test asserting the allDay/durationMin invariant holds
// against the RESULTING state, not just an incoming allDay:true.
func TestUpdateCalendarEventAllDayDurationInvariant(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	// (a) timed event with a duration -> PATCH allDay:true clears it.
	timed := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":       "Timed",
		"startTime":   futureISO(24 * hour),
		"allDay":      false,
		"durationMin": 45,
	})
	if timed.Status != http.StatusCreated {
		t.Fatalf("create timed status = %d, body %s", timed.Status, timed.Raw)
	}
	timedID, _ := timed.JSON["id"].(string)

	toAllDay := a.Do(http.MethodPatch, "/api/calendar/events/"+timedID, cookie, map[string]any{"allDay": true})
	if toAllDay.Status != http.StatusOK {
		t.Fatalf("PATCH allDay status = %d, body %s", toAllDay.Status, toAllDay.Raw)
	}
	if toAllDay.JSON["durationMin"] != nil {
		t.Errorf("durationMin after allDay:true = %v, want nil", toAllDay.JSON["durationMin"])
	}

	// (b) already-all-day event -> PATCH durationMin alone must not stick.
	allDay := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":     "Already all-day",
		"startTime": futureISO(24 * hour),
		"allDay":    true,
	})
	if allDay.Status != http.StatusCreated {
		t.Fatalf("create all-day status = %d, body %s", allDay.Status, allDay.Raw)
	}
	allDayID, _ := allDay.JSON["id"].(string)

	durationOnly := a.Do(http.MethodPatch, "/api/calendar/events/"+allDayID, cookie, map[string]any{"durationMin": 45})
	if durationOnly.Status != http.StatusOK {
		t.Fatalf("PATCH durationMin status = %d, body %s", durationOnly.Status, durationOnly.Raw)
	}
	if durationOnly.JSON["durationMin"] != nil {
		t.Errorf("durationMin after PATCH on all-day event = %v, want still nil", durationOnly.JSON["durationMin"])
	}
}

// TestUpdateCalendarEventRearmsReminderLatch ports the TS test that
// simulates a fired reminder (remindedAt set) and asserts a startTime
// PATCH clears it back to NULL. remindedAt is never exposed over the API
// (CalendarEventSchema omits it), so this reads/writes it directly
// through the rig's Pool — same as the TS test reading schema.calendarEvent
// straight from Drizzle.
func TestUpdateCalendarEventRearmsReminderLatch(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":               "Reminder test",
		"startTime":           futureISO(24 * hour),
		"remindMinutesBefore": 60,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	ctx := context.Background()
	if _, err := a.Deps.Pool.Exec(ctx, `UPDATE "calendar_event" SET "reminded_at" = now() WHERE "id" = $1`, id); err != nil {
		t.Fatalf("simulate fired reminder: %v", err)
	}

	patched := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"startTime": futureISO(48 * hour)})
	if patched.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", patched.Status, patched.Raw)
	}

	var remindedAt *time.Time
	if err := a.Deps.Pool.QueryRow(ctx, `SELECT "reminded_at" FROM "calendar_event" WHERE "id" = $1`, id).Scan(&remindedAt); err != nil {
		t.Fatalf("read reminded_at: %v", err)
	}
	if remindedAt != nil {
		t.Errorf("reminded_at after startTime PATCH = %v, want NULL (re-armed)", *remindedAt)
	}
}

// TestUpdateCalendarEventRearmsReminderLatchOnLeadTimeChange is the
// second trigger for the same reset: apps/api/src/routes/calendar.ts
// re-arms on EITHER startTime or remindMinutesBefore changing
// (`body.startTime !== undefined || body.remindMinutesBefore !==
// undefined`) — this covers the lead-time-only half the previous test
// doesn't.
func TestUpdateCalendarEventRearmsReminderLatchOnLeadTimeChange(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/calendar/events", cookie, map[string]any{
		"title":               "Reminder test",
		"startTime":           futureISO(24 * hour),
		"remindMinutesBefore": 60,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	ctx := context.Background()
	if _, err := a.Deps.Pool.Exec(ctx, `UPDATE "calendar_event" SET "reminded_at" = now() WHERE "id" = $1`, id); err != nil {
		t.Fatalf("simulate fired reminder: %v", err)
	}

	patched := a.Do(http.MethodPatch, "/api/calendar/events/"+id, cookie, map[string]any{"remindMinutesBefore": 120})
	if patched.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", patched.Status, patched.Raw)
	}

	var remindedAt *time.Time
	if err := a.Deps.Pool.QueryRow(ctx, `SELECT "reminded_at" FROM "calendar_event" WHERE "id" = $1`, id).Scan(&remindedAt); err != nil {
		t.Fatalf("read reminded_at: %v", err)
	}
	if remindedAt != nil {
		t.Errorf("reminded_at after remindMinutesBefore PATCH = %v, want NULL (re-armed)", *remindedAt)
	}
}
