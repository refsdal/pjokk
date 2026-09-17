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

// The barnehage closing alert (daycare_closing.go, spec
// docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
// No TypeScript ancestor: the feature postdates the Go migration.

// closingWorld is a family of two — an admin and a plain member — with one
// baby enrolled at a place that closes 16:30 Oslo time, alert lead 30 min.
type closingWorld struct {
	a        *testrig.AppRig
	cookie   string
	familyID string
	babyID   string
	adminID  string
	memberID string
}

func newClosingWorld(t *testing.T) closingWorld {
	t.Helper()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	memberID := a.SignUp("Bo Hansen", "bo@example.com")
	a.AddMember(familyID, memberID, auth.RoleMember, "bo@example.com")
	res := a.Do(http.MethodPost, "/api/daycare-places", cookie, map[string]any{
		"name": "Solsikken", "closeMinute": 16*60 + 30, "alertLeadMin": 30,
		"tz": "Europe/Oslo", "babyIds": []string{babyID},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create place: %d %s", res.Status, res.Raw)
	}
	return closingWorld{a: a, cookie: cookie, familyID: familyID, babyID: babyID,
		adminID: userIDByEmail(t, a, "anne@example.com"), memberID: memberID}
}

func (w closingWorld) plan(t *testing.T, days ...map[string]any) {
	t.Helper()
	if res := w.a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/pickup-plan", w.cookie, map[string]any{"days": days}); res.Status != http.StatusOK {
		t.Fatalf("set plan: %d %s", res.Status, res.Raw)
	}
}

func runClosing(t *testing.T, a *testrig.AppRig, now time.Time) int {
	t.Helper()
	sent, err := jobs.RunDaycareClosingAlerts(context.Background(), depsFor(a), now)
	if err != nil {
		t.Fatalf("RunDaycareClosingAlerts: %v", err)
	}
	return sent
}

// Monday 16 March 2026, when Oslo is UTC+1.
func osloMarch16(h, m int) time.Time {
	return time.Date(2026, 3, 16, h-1, m, 0, 0, time.UTC)
}

func TestClosingAlertGoesOnceToThePlannedPerson(t *testing.T) {
	w := newClosingWorld(t)
	w.plan(t, map[string]any{"weekday": 1, "minute": 15*60 + 30, "userId": w.memberID})
	dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))

	// 15:45 — the expected time has passed, and that fires nothing.
	if sent := runClosing(t, w.a, osloMarch16(15, 45)); sent != 0 {
		t.Fatalf("sent at 15:45 = %d, want 0 (the expected time is a plan, not a deadline)", sent)
	}
	if sent := runClosing(t, w.a, osloMarch16(16, 0)); sent != 1 {
		t.Fatalf("sent at 16:00 = %d, want 1", sent)
	}
	got := w.a.Push.Sent(w.memberID)
	if len(got) != 1 || got[0].Title != "Nora is still at daycare" || got[0].Body != "Solsikken closes at 16:30" || got[0].URL != "/home" {
		t.Errorf("the planned person got %+v", got)
	}
	if len(got) == 1 && len(got[0].Actions) != 0 {
		t.Errorf("actions = %+v, want none: closing time does not move, so no Snooze", got[0].Actions)
	}
	if n := w.a.Push.Count(w.adminID); n != 0 {
		t.Errorf("the other parent got %d, want 0", n)
	}
	// Latched: said once per day there.
	if sent := runClosing(t, w.a, osloMarch16(16, 15)); sent != 0 {
		t.Errorf("sent at 16:15 = %d, want 0 (already said)", sent)
	}
}

func TestClosingAlertPrefersTodaysException(t *testing.T) {
	w := newClosingWorld(t)
	w.plan(t, map[string]any{"weekday": 1, "minute": 930, "userId": w.memberID})
	if res := w.a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/pickup-override", w.cookie, map[string]any{"date": "2026-03-16", "userId": w.adminID}); res.Status != http.StatusOK {
		t.Fatalf("override: %d %s", res.Status, res.Raw)
	}
	dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
	if sent := runClosing(t, w.a, osloMarch16(16, 5)); sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
	if w.a.Push.Count(w.adminID) != 1 || w.a.Push.Count(w.memberID) != 0 {
		t.Errorf("admin %d, member %d; want the exception's person alone", w.a.Push.Count(w.adminID), w.a.Push.Count(w.memberID))
	}
}

func TestClosingAlertFallsBackToTheParents(t *testing.T) {
	t.Run("nobody named", func(t *testing.T) {
		w := newClosingWorld(t)
		w.plan(t, map[string]any{"weekday": 1, "minute": 930, "userId": nil})
		dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
		if sent := runClosing(t, w.a, osloMarch16(16, 0)); sent != 1 {
			t.Fatalf("sent = %d, want 1 (the one admin)", sent)
		}
		if w.a.Push.Count(w.adminID) != 1 || w.a.Push.Count(w.memberID) != 0 {
			t.Errorf("admin %d, member %d; want the admin alone", w.a.Push.Count(w.adminID), w.a.Push.Count(w.memberID))
		}
	})
	t.Run("the named person is not a member", func(t *testing.T) {
		w := newClosingWorld(t)
		// RemoveMember clears the grid, so a surviving row is forged: the
		// job's own membership check is what must hold.
		stranger := w.a.SignUp("Siv Berg", "siv@example.com")
		if _, err := w.a.Rig.Pool.Exec(context.Background(),
			`INSERT INTO "daycare_pickup_plan" ("family_id", "baby_id", "weekday", "user_id") VALUES ($1, $2, 1, $3)`,
			w.familyID, w.babyID, stranger); err != nil {
			t.Fatal(err)
		}
		dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
		if sent := runClosing(t, w.a, osloMarch16(16, 0)); sent != 1 {
			t.Fatalf("sent = %d, want 1", sent)
		}
		if w.a.Push.Count(stranger) != 0 || w.a.Push.Count(w.adminID) != 1 {
			t.Errorf("stranger %d, admin %d; want the admin alone", w.a.Push.Count(stranger), w.a.Push.Count(w.adminID))
		}
	})
}

func TestClosingAlertStaysQuietWhenItShould(t *testing.T) {
	t.Run("picked up in time", func(t *testing.T) {
		w := newClosingWorld(t)
		id := dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
		pickUp(t, w.a, w.cookie, id, osloMarch16(15, 30))
		if sent := runClosing(t, w.a, osloMarch16(16, 15)); sent != 0 {
			t.Errorf("sent = %d, want 0", sent)
		}
	})
	t.Run("no lead set", func(t *testing.T) {
		w := newClosingWorld(t)
		places := w.a.DoArray(http.MethodGet, "/api/daycare-places", w.cookie, nil)
		id, _ := places.JSON[0].(map[string]any)["id"].(string)
		if res := w.a.Do(http.MethodPut, "/api/daycare-places/"+id, w.cookie, map[string]any{"name": "Solsikken", "closeMinute": 990, "tz": "Europe/Oslo", "babyIds": []string{w.babyID}}); res.Status != http.StatusOK {
			t.Fatalf("PUT: %d %s", res.Status, res.Raw)
		}
		dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
		if sent := runClosing(t, w.a, osloMarch16(16, 15)); sent != 0 {
			t.Errorf("sent = %d, want 0 (the family switched the alert off)", sent)
		}
	})
	t.Run("a session left running since yesterday", func(t *testing.T) {
		w := newClosingWorld(t)
		dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0).AddDate(0, 0, -1))
		if sent := runClosing(t, w.a, osloMarch16(16, 15)); sent != 0 {
			t.Errorf("sent = %d, want 0 (a forgotten pick-up tap says nothing about today)", sent)
		}
	})
}

// After an outage: within the hour it still says so, in the past tense;
// beyond it the day is latched without a word.
func TestClosingAlertAfterClosing(t *testing.T) {
	w := newClosingWorld(t)
	dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
	if sent := runClosing(t, w.a, osloMarch16(16, 50)); sent != 1 {
		t.Fatalf("sent at 16:50 = %d, want 1", sent)
	}
	if got := w.a.Push.Sent(w.adminID); len(got) != 1 || got[0].Body != "Solsikken closed at 16:30" {
		t.Errorf("got %+v, want the past tense", got)
	}

	late := newClosingWorld(t)
	id := dropOff(t, late.a, late.cookie, late.babyID, osloMarch16(8, 0))
	if sent := runClosing(t, late.a, osloMarch16(17, 45)); sent != 0 {
		t.Fatalf("sent at 17:45 = %d, want 0", sent)
	}
	var latched bool
	if err := late.a.Rig.Pool.QueryRow(context.Background(), `SELECT "closing_alerted_at" IS NOT NULL FROM "daycare_log" WHERE "id" = $1`, id).Scan(&latched); err != nil {
		t.Fatal(err)
	}
	if !latched {
		t.Error("a day long past closing was not latched")
	}
}

// 29 March 2026: Oslo's clocks go forward at 02:00, so local midnight plus
// 16.5 hours is 17:30 on the wall. Closing is 16:30 on the wall all the same.
func TestClosingAlertOnAClockChangeDay(t *testing.T) {
	w := newClosingWorld(t)
	oslo := func(h, m int) time.Time { return time.Date(2026, 3, 29, h-2, m, 0, 0, time.UTC) } // CEST from 03:00
	dropOff(t, w.a, w.cookie, w.babyID, oslo(8, 0))
	if sent := runClosing(t, w.a, oslo(15, 50)); sent != 0 {
		t.Fatalf("sent at 15:50 = %d, want 0", sent)
	}
	if sent := runClosing(t, w.a, oslo(16, 5)); sent != 1 {
		t.Fatalf("sent at 16:05 = %d, want 1", sent)
	}
}

func TestClosingAlertIsInThePersonsLanguage(t *testing.T) {
	w := newClosingWorld(t)
	speaksNorwegian(t, w.a, w.cookie)
	dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
	runClosing(t, w.a, osloMarch16(16, 0))
	got := w.a.Push.Sent(w.adminID)
	if len(got) != 1 || got[0].Title != "Nora er fortsatt i barnehagen" || got[0].Body != "Solsikken stenger kl. 16:30" {
		t.Errorf("got %+v", got)
	}
}

// Barnehage switched off for the baby (spec
// 2026-09-17-per-baby-tracking-design.md): enrolled or not, no alert.
func TestClosingAlertSkipsABabyNotTrackingDaycare(t *testing.T) {
	w := newClosingWorld(t)
	if res := w.a.Do(http.MethodPut, "/api/babies/"+w.babyID+"/features", w.cookie, map[string]any{"features": []string{"sleep"}}); res.Status != http.StatusOK {
		t.Fatalf("set features: %d %s", res.Status, res.Raw)
	}
	dropOff(t, w.a, w.cookie, w.babyID, osloMarch16(8, 0))
	if sent := runClosing(t, w.a, osloMarch16(16, 15)); sent != 0 {
		t.Errorf("sent = %d, want 0 (daycare is not tracked for her)", sent)
	}
}
