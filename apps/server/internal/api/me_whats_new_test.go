package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// What's new, and a first run (issue #140): the marker is the person's and
// only ever moves forward, and a fresh account has not been onboarded.
func TestMeWhatsNewDefaults(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if me.JSON["whatsNewSeq"] != float64(0) {
		t.Errorf("default whatsNewSeq = %v, want 0", me.JSON["whatsNewSeq"])
	}
	// NewFamily creates the row through the ordinary signup path, i.e.
	// after 00034 — so it is NOT backfilled and must start un-onboarded.
	if me.JSON["onboarded"] != false {
		t.Errorf("a fresh account's onboarded = %v, want false", me.JSON["onboarded"])
	}
}

// The marker only ever moves forward. Without GREATEST in the query, an
// offline dismissal replaying after a newer one would re-show entries.
func TestMeWhatsNewSeqNeverGoesBackwards(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": 7}); res.Status != http.StatusOK || res.JSON["whatsNewSeq"] != float64(7) {
		t.Fatalf("set 7 = %d %v", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": 3}); res.JSON["whatsNewSeq"] != float64(7) {
		t.Errorf("after replaying a stale 3, whatsNewSeq = %v, want 7", res.JSON["whatsNewSeq"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": 9}); res.JSON["whatsNewSeq"] != float64(9) {
		t.Errorf("moving forward to 9 = %v", res.JSON["whatsNewSeq"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"nickname": "Pappa"}); res.JSON["whatsNewSeq"] != float64(9) {
		t.Errorf("an unrelated PATCH changed whatsNewSeq to %v", res.JSON["whatsNewSeq"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"whatsNewSeq": -1}); res.Status != http.StatusBadRequest {
		t.Errorf("whatsNewSeq=-1 = %d, want 400", res.Status)
	}
}

// onboarded is a bool on the wire over a timestamptz in the row, and the
// date survives a re-run of the tour from Settings.
func TestMeOnboardedRoundTrip(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"onboarded": true}); res.Status != http.StatusOK || res.JSON["onboarded"] != true {
		t.Fatalf("set onboarded = %d %v", res.Status, res.JSON)
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"units": "imperial"}); res.JSON["onboarded"] != true {
		t.Errorf("an unrelated PATCH changed onboarded to %v", res.JSON["onboarded"])
	}
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"onboarded": false}); res.JSON["onboarded"] != false {
		t.Errorf("clearing onboarded = %v", res.JSON["onboarded"])
	}
	if me := a.Do(http.MethodGet, "/api/me", cookie, nil); me.JSON["onboarded"] != false {
		t.Errorf("onboarded after clear = %v", me.JSON["onboarded"])
	}
}

// Additional requirement from the Task 1 review: the GET/PATCH pair only
// exposes onboarded as a bool, so a second "onboarded: true" PATCH looks
// like a no-op through the wire. Assert directly against the row that the
// stored onboarded_at timestamp does not move on a repeat set — the SQL
// (UpdateUserProfile's `onboarded_at = COALESCE("onboarded_at", now())`
// case, internal/db/queries/profile.sql) is what makes that true, and this
// test is the one thing pinning it.
func TestMeOnboardedTimestampDoesNotMoveOnRepeatSet(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	ctx := context.Background()
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"onboarded": true}); res.Status != http.StatusOK || res.JSON["onboarded"] != true {
		t.Fatalf("set onboarded = %d %v", res.Status, res.JSON)
	}

	var first pgtype.Timestamptz
	if err := a.Rig.Pool.QueryRow(ctx, `SELECT "onboarded_at" FROM "users" WHERE "email" = $1`, "parent@example.com").Scan(&first); err != nil {
		t.Fatalf("read onboarded_at: %v", err)
	}

	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"onboarded": true}); res.Status != http.StatusOK || res.JSON["onboarded"] != true {
		t.Fatalf("second set onboarded = %d %v", res.Status, res.JSON)
	}

	var second pgtype.Timestamptz
	if err := a.Rig.Pool.QueryRow(ctx, `SELECT "onboarded_at" FROM "users" WHERE "email" = $1`, "parent@example.com").Scan(&second); err != nil {
		t.Fatalf("read onboarded_at (second): %v", err)
	}

	if !first.Time.Equal(second.Time) {
		t.Errorf("onboarded_at moved on a repeat set: %v -> %v", first.Time, second.Time)
	}
}
