package restore_test

// The family restore (spec 2026-09-11-admin-restore §2): one deleted
// family back from a snapshot, and nothing else touched.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/restore"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// familyCounts is how many rows a family has in each table that carries
// its id.
func familyCounts(t *testing.T, a *testrig.AppRig, familyID string) map[string]int {
	t.Helper()
	ctx := context.Background()
	rows, err := a.Deps.Pool.Query(ctx, `
		SELECT "table_name", "column_name" FROM information_schema.columns
		WHERE "table_schema" = 'public' AND "column_name" IN ('family_id', 'organization_id')`)
	if err != nil {
		t.Fatal(err)
	}
	type tc struct{ table, column string }
	var tables []tc
	for rows.Next() {
		var x tc
		if err := rows.Scan(&x.table, &x.column); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, x)
	}
	rows.Close()
	out := map[string]int{}
	for _, x := range tables {
		var n int
		if err := a.Deps.Pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %q WHERE %q = $1`, x.table, x.column), familyID).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", x.table, err)
		}
		out[x.table] = n
	}
	return out
}

// backupThenDelete takes tonight's snapshot and then deletes the family,
// the way the console's delete does.
func backupThenDelete(t *testing.T, a *testrig.AppRig, familyID string) *restore.Snapshot {
	t.Helper()
	ctx := context.Background()
	if _, err := jobs.RunBackup(ctx, jobsDeps(a), time.Date(2026, 9, 10, 3, 15, 0, 0, time.UTC)); err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	snap, err := restore.FromStorage(ctx, a.Deps.Storage, "2026-09-10")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Deps.Pool.Exec(ctx, `DELETE FROM "organizations" WHERE "id" = $1`, familyID); err != nil {
		t.Fatalf("delete family: %v", err)
	}
	return snap
}

func scalar[T any](t *testing.T, a *testrig.AppRig, sql string, args ...any) T {
	t.Helper()
	var v T
	if err := a.Deps.Pool.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return v
}

func TestFamilyRestoreBringsBackADeletedFamily(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	hansen, _, milestone := seedFamily(t, a, "Hansen", "parent@example.com")
	berg, bergBaby, _ := seedFamily(t, a, "Berg", "berg@example.com")
	photo := addPhoto(t, a, hansen, milestone, "p1")
	before := familyCounts(t, a, hansen)
	bergBefore := familyCounts(t, a, berg)

	snap := backupThenDelete(t, a, hansen)
	// The night after, the photo backup moves the gone photo's copy aside.
	putObject(t, a, "photo-backups/deleted/2026-09-11/"+hansen+"/p1.jpg", "jpeg")
	// Berg carries on after the snapshot; the restore must not notice.
	mustDo(t, a, "/api/feeds", a.SignIn("berg@example.com"), map[string]any{
		"babyId": bergBaby, "time": time.Now().UTC().Format(time.RFC3339), "type": "bottle", "amountMl": 90,
	})

	rep, err := restore.Family(ctx, restoreDeps(a), snap, hansen, nil)
	if err != nil {
		t.Fatalf("Family: %v", err)
	}

	after := familyCounts(t, a, hansen)
	for table, n := range before {
		want := n
		if table == "api_key" || table == "device" || table == "push_subscription" {
			want = 0 // credentials and device bindings stay gone
		}
		if after[table] != want {
			t.Errorf("%s: %d rows after the restore, want %d", table, after[table], want)
		}
	}
	if before["baby"] == 0 || before["feed_log"] == 0 || before["api_key"] == 0 || before["device"] == 0 {
		t.Fatalf("the seed did not fill the tables this test is about: %v", before)
	}
	bergAfter := familyCounts(t, a, berg)
	if bergAfter["feed_log"] != bergBefore["feed_log"]+1 || bergAfter["api_key"] != bergBefore["api_key"] {
		t.Errorf("Berg changed: %v → %v", bergBefore, bergAfter)
	}
	if rep.Name != "Hansen" || rep.MembersRejoined != 1 || rep.MembersDropped != 0 || !rep.HasAdmin || rep.PreviousSlug != "" {
		t.Errorf("report = %+v", rep)
	}
	if body, _ := object(a, photo); body != "jpeg" || rep.PhotosRestored != 1 {
		t.Errorf("photo = %q (restored %d), want it back from the deleted tree", body, rep.PhotosRestored)
	}
}

func TestFamilyRestoreRefusesALiveOrUnknownFamily(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	hansen, _, _ := seedFamily(t, a, "Hansen", "parent@example.com")
	if _, err := jobs.RunBackup(ctx, jobsDeps(a), time.Date(2026, 9, 10, 3, 15, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	snap, err := restore.FromStorage(ctx, a.Deps.Storage, "2026-09-10")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restore.Family(ctx, restoreDeps(a), snap, hansen, nil); !errors.Is(err, restore.ErrFamilyExists) {
		t.Errorf("a live family = %v, want ErrFamilyExists", err)
	}
	if _, err := restore.Family(ctx, restoreDeps(a), snap, "no-such-family", nil); !errors.Is(err, restore.ErrFamilyNotInSnapshot) {
		t.Errorf("an unknown family = %v, want ErrFamilyNotInSnapshot", err)
	}
}

// A member whose account was deleted since: their membership, roles and
// reminders stay gone, and what they logged is the Deleted user's.
func TestFamilyRestoreDropsGoneMembersAndCreditsTheirEntries(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	hansen, baby, _ := seedFamily(t, a, "Hansen", "parent@example.com")
	bo := a.SignUp("Bo", "bo@example.com")
	boCookie := a.AddMember(hansen, bo, auth.RoleMember, "bo@example.com")
	feed := mustDo(t, a, "/api/feeds", boCookie, map[string]any{
		"babyId": baby, "time": time.Now().UTC().Format(time.RFC3339), "type": "bottle", "amountMl": 60,
	})
	if res := a.Do(http.MethodPost, "/api/reminders", boCookie, map[string]any{
		"kind": "feed", "mode": "since_last", "intervalMin": 180, "tz": "UTC",
	}); res.Status != http.StatusCreated {
		t.Fatalf("reminder: %d %s", res.Status, res.Raw)
	}

	snap := backupThenDelete(t, a, hansen)
	if _, err := a.Deps.Pool.Exec(ctx, `DELETE FROM "users" WHERE "id" = $1`, bo); err != nil {
		t.Fatalf("delete Bo: %v", err)
	}

	rep, err := restore.Family(ctx, restoreDeps(a), snap, hansen, nil)
	if err != nil {
		t.Fatalf("Family: %v", err)
	}
	if rep.MembersRejoined != 1 || rep.MembersDropped != 1 || !rep.HasAdmin {
		t.Errorf("report = %+v, want the parent back, Bo dropped, an admin left", rep)
	}
	if got := scalar[string](t, a, `SELECT "caretaker_id" FROM "feed_log" WHERE "id" = $1`, feed); got != db.TombstoneID {
		t.Errorf("Bo's feed is credited to %q, want the tombstone", got)
	}
	if n := scalar[int](t, a, `SELECT count(*) FROM "reminder" WHERE "user_id" = $1`, bo); n != 0 {
		t.Errorf("Bo's reminders came back: %d", n)
	}
	if n := scalar[int](t, a, `SELECT count(*) FROM "organization_member_roles" WHERE "organization_id" = $1`, hansen); n != 1 {
		t.Errorf("member roles = %d, want the parent's alone", n)
	}
}

func TestFamilyRestoreWithEveryAdminGone(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	hansen, _, _ := seedFamily(t, a, "Hansen", "parent@example.com")
	parent := userID(t, a, "parent@example.com")
	bo := a.SignUp("Bo", "bo@example.com")
	a.AddMember(hansen, bo, auth.RoleMember, "bo@example.com")

	snap := backupThenDelete(t, a, hansen)
	if _, err := a.Deps.Pool.Exec(ctx, `DELETE FROM "users" WHERE "id" = $1`, parent); err != nil {
		t.Fatalf("delete the parent: %v", err)
	}
	rep, err := restore.Family(ctx, restoreDeps(a), snap, hansen, nil)
	if err != nil {
		t.Fatalf("Family: %v", err)
	}
	if rep.HasAdmin || rep.MembersRejoined != 1 || rep.MembersDropped != 1 {
		t.Errorf("report = %+v, want Bo back and no admin", rep)
	}
}

func TestFamilyRestoreRenamesATakenSlug(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	hansen, _, _ := seedFamily(t, a, "Hansen", "parent@example.com")
	slug := scalar[string](t, a, `SELECT "slug" FROM "organizations" WHERE "id" = $1`, hansen)

	snap := backupThenDelete(t, a, hansen)
	if _, err := a.Deps.Pool.Exec(ctx, `INSERT INTO "organizations" ("id", "name", "slug") VALUES ('other', 'Other', $1)`, slug); err != nil {
		t.Fatal(err)
	}
	rep, err := restore.Family(ctx, restoreDeps(a), snap, hansen, nil)
	if err != nil {
		t.Fatalf("Family: %v", err)
	}
	now := scalar[string](t, a, `SELECT "slug" FROM "organizations" WHERE "id" = $1`, hansen)
	if rep.Slug != slug+"-restored" || rep.PreviousSlug != slug || now != rep.Slug {
		t.Errorf("slug = %q (report %q, previous %q), want %q", now, rep.Slug, rep.PreviousSlug, slug+"-restored")
	}
}

// The console's audit row is written in the restore's transaction: when it
// fails, nothing is restored.
func TestFamilyRestoreRollsBackWhenTheHookFails(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	hansen, _, _ := seedFamily(t, a, "Hansen", "parent@example.com")
	snap := backupThenDelete(t, a, hansen)

	_, err := restore.Family(ctx, restoreDeps(a), snap, hansen, func(context.Context, pgx.Tx) error {
		return errors.New("audit write failed")
	})
	if err == nil {
		t.Fatal("Family = nil, want the hook's error")
	}
	if n := familyCounts(t, a, hansen)["baby"]; n != 0 || scalar[bool](t, a, `SELECT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = $1)`, hansen) {
		t.Errorf("a failed restore left rows (%d babies)", n)
	}
}

// Every table has a rule: a new one without fails here until someone
// decides whether a family restore brings it back.
func TestEveryTableHasAFamilyRestoreRule(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	unplaced, err := restore.UnclassifiedTables(ctx, a.Deps.Pool)
	if err != nil {
		t.Fatal(err)
	}
	if len(unplaced) != 0 {
		t.Fatalf("tables with no family-restore rule: %v (add them to restore's globalTables or neverForAFamily, or give them a family_id)", unplaced)
	}

	if _, err := a.Deps.Pool.Exec(ctx, `CREATE TABLE "zz_unplaced" ("id" text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = a.Deps.Pool.Exec(context.Background(), `DROP TABLE IF EXISTS "zz_unplaced"`) })
	unplaced, err = restore.UnclassifiedTables(ctx, a.Deps.Pool)
	if err != nil || !slices.Contains(unplaced, "zz_unplaced") {
		t.Errorf("a new global table = %v, %v; want it named", unplaced, err)
	}
}

func TestDeletedFamiliesListsOnlyTheGoneOnes(t *testing.T) {
	a := testrig.App(t)
	hansen, _, _ := seedFamily(t, a, "Hansen", "parent@example.com")
	seedFamily(t, a, "Berg", "berg@example.com")
	snap := backupThenDelete(t, a, hansen)

	gone, err := restore.DeletedFamilies(context.Background(), a.Deps.Pool, snap)
	if err != nil {
		t.Fatal(err)
	}
	if len(gone) != 1 || gone[0].ID != hansen || gone[0].Name != "Hansen" || gone[0].Members != 1 || gone[0].Babies != 1 {
		t.Errorf("deleted families = %+v, want Hansen alone with one member and one baby", gone)
	}
}
