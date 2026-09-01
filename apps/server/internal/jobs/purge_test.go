package jobs_test

import (
	"context"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Ports apps/api/test/security.test.ts's "purges week-old accounts with no
// family; keeps members and admins (H2)" — deferred from Task 22 per the
// Task 23 brief.
func TestPurgeOrphanUsersKeepsMembersAndAdmins(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()

	old := time.Now().Add(-8 * 24 * time.Hour)

	orphanID := a.SignUp("Orphan", "orphan@example.com")
	freshOrphanID := a.SignUp("Fresh orphan", "fresh-orphan@example.com")
	adminOrphanID := a.SignUp("Admin no family", "admin-no-family@example.com")
	memberFamilyID, _ := a.NewFamily("Hansen", "member@example.com")
	memberUserID := userIDByEmail(t, a, "member@example.com")
	_ = memberFamilyID

	setCreatedAt(t, a, orphanID, old)
	setCreatedAt(t, a, adminOrphanID, old)
	makeAdmin(t, a, adminOrphanID)
	setCreatedAt(t, a, memberUserID, old)

	d := depsFor(a)
	purged, err := jobs.PurgeOrphanUsers(ctx, d, time.Now())
	if err != nil {
		t.Fatalf("PurgeOrphanUsers: %v", err)
	}
	if purged < 1 {
		t.Fatalf("purged = %d, want at least 1", purged)
	}

	remaining := allUserIDs(t, a)
	if contains(remaining, orphanID) {
		t.Errorf("orphan account survived purge")
	}
	if !contains(remaining, freshOrphanID) {
		t.Errorf("fresh orphan (< 7 days old) was purged, want kept")
	}
	if !contains(remaining, adminOrphanID) {
		t.Errorf("sysadmin orphan was purged, want kept")
	}
	if !contains(remaining, memberUserID) {
		t.Errorf("member with a family was purged, want kept")
	}
}

func TestPurgeOrphanUsersIsANoOpWhenNoneQualify(t *testing.T) {
	a := testrig.App(t)
	_, _ = a.NewFamily("Hansen", "parent@example.com")

	d := depsFor(a)
	purged, err := jobs.PurgeOrphanUsers(context.Background(), d, time.Now())
	if err != nil {
		t.Fatalf("PurgeOrphanUsers: %v", err)
	}
	if purged != 0 {
		t.Errorf("purged = %d, want 0 (fresh admin with a family)", purged)
	}
}

// Proves the FK-blocked branch: an orphan (no membership row — the ONLY
// thing ListOrphanUsers checks) that nonetheless left historical data
// behind (a log row attributed to it, e.g. logged before the family kicked
// them or a data quirk from an earlier bug) must not fail the whole sweep
// or panic — the delete is swallowed and the account stays exactly as it
// was, so a later manual cleanup can still find it.
func TestPurgeOrphanUsersSwallowsForeignKeyBlockedDeletes(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()

	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	blockedID := a.SignUp("Attributed orphan", "attributed@example.com")
	setCreatedAt(t, a, blockedID, time.Now().Add(-8*24*time.Hour))

	// Attribute a feed log to the orphan directly (bypassing the normal
	// authenticated route, which would require them to be a member) — the
	// feed_log.caretaker_id FK has no ON DELETE clause, so it blocks the
	// delete.
	if _, err := a.Rig.Pool.Exec(ctx, `
		INSERT INTO "feed_log" ("family_id", "baby_id", "caretaker_id", "time", "type", "amount_ml")
		VALUES ($1, $2, $3, now(), 'bottle', 90)`,
		familyID, babyID, blockedID); err != nil {
		t.Fatalf("attribute feed log to orphan: %v", err)
	}
	_ = cookie

	d := depsFor(a)
	purged, err := jobs.PurgeOrphanUsers(ctx, d, time.Now())
	if err != nil {
		t.Fatalf("PurgeOrphanUsers: %v", err)
	}
	if purged != 0 {
		t.Errorf("purged = %d, want 0 (the only orphan is FK-blocked)", purged)
	}

	if !contains(allUserIDs(t, a), blockedID) {
		t.Errorf("FK-blocked orphan was removed, want kept")
	}
}

func setCreatedAt(t *testing.T, a *testrig.AppRig, userID string, ts time.Time) {
	t.Helper()
	if _, err := a.Rig.Pool.Exec(context.Background(),
		`UPDATE "users" SET "created_at" = $1 WHERE "id" = $2`, ts, userID); err != nil {
		t.Fatalf("setCreatedAt(%q): %v", userID, err)
	}
}

func makeAdmin(t *testing.T, a *testrig.AppRig, userID string) {
	t.Helper()
	if _, err := a.Rig.Pool.Exec(context.Background(),
		`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, userID); err != nil {
		t.Fatalf("makeAdmin(%q): %v", userID, err)
	}
}

func allUserIDs(t *testing.T, a *testrig.AppRig) []string {
	t.Helper()
	rows, err := a.Rig.Pool.Query(context.Background(), `SELECT "id" FROM "users"`)
	if err != nil {
		t.Fatalf("list users: %v", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan user id: %v", err)
		}
		ids = append(ids, id)
	}
	return ids
}

func contains(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
