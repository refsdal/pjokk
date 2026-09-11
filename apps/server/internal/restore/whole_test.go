package restore_test

// The whole-database restore (spec 2026-09-11-admin-restore §1). External
// tests: the rig imports internal/api, which imports this package.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/restore"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func restoreDeps(a *testrig.AppRig) restore.Deps {
	return restore.Deps{Pool: a.Deps.Pool, Storage: a.Deps.Storage}
}

func jobsDeps(a *testrig.AppRig) jobs.Deps {
	return jobs.Deps{Pool: a.Deps.Pool, Q: a.Deps.Q, Storage: a.Deps.Storage, Push: a.Push, Now: a.Deps.Now}
}

// fingerprint is every backed-up table's rows as Postgres renders them,
// in a stable order — what "the same data" means for a round trip.
func fingerprint(t *testing.T, a *testrig.AppRig) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, table := range jobs.BackupTables {
		var rows string
		if err := a.Deps.Pool.QueryRow(context.Background(), fmt.Sprintf(
			`SELECT COALESCE(json_agg(t ORDER BY t::text), '[]')::text FROM %q t`, table),
		).Scan(&rows); err != nil {
			t.Fatalf("fingerprint %s: %v", table, err)
		}
		out[table] = rows
	}
	return out
}

// diffRows is the rows of two json_agg arrays that are in one and not the
// other.
func diffRows(t *testing.T, before, after string) (gone, extra []string) {
	t.Helper()
	var b, a []json.RawMessage
	if err := json.Unmarshal([]byte(before), &b); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(after), &a); err != nil {
		t.Fatal(err)
	}
	count := map[string]int{}
	for _, r := range b {
		count[string(r)]++
	}
	for _, r := range a {
		count[string(r)]--
	}
	for row, n := range count {
		for ; n > 0; n-- {
			gone = append(gone, row)
		}
		for ; n < 0; n++ {
			extra = append(extra, row)
		}
	}
	return gone, extra
}

func mustDo(t *testing.T, a *testrig.AppRig, path, cookie string, body map[string]any) string {
	t.Helper()
	res := a.Do(http.MethodPost, path, cookie, body)
	if res.Status != http.StatusCreated {
		t.Fatalf("POST %s = %d %s", path, res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	return id
}

func userID(t *testing.T, a *testrig.AppRig, email string) string {
	t.Helper()
	var id string
	if err := a.Deps.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "users" WHERE "email" = $1`, email).Scan(&id); err != nil {
		t.Fatalf("user %s: %v", email, err)
	}
	return id
}

func putObject(t *testing.T, a *testrig.AppRig, key, body string) {
	t.Helper()
	if err := a.Deps.Storage.Put(context.Background(), key, strings.NewReader(body), int64(len(body)), "image/jpeg"); err != nil {
		t.Fatalf("put %s: %v", key, err)
	}
}

func object(a *testrig.AppRig, key string) (string, bool) {
	b, ok := a.Deps.Storage.(*storage.Memory).Read(key)
	return string(b), ok
}

// seedFamily is a family with something in most of its tables.
func seedFamily(t *testing.T, a *testrig.AppRig, name, email string) (familyID, babyID, milestoneID string) {
	t.Helper()
	familyID, cookie := a.NewFamily(name, email)
	babyID = a.NewBaby(familyID, "Nora")
	now := time.Now().UTC().Truncate(time.Second)
	mustDo(t, a, "/api/feeds", cookie, map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "type": "bottle", "amountMl": 130})
	mustDo(t, a, "/api/diapers", cookie, map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "type": "wet"})
	mustDo(t, a, "/api/sleep-locations", cookie, map[string]any{"name": "Hammock"})
	milestoneID = mustDo(t, a, "/api/milestones", cookie, map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "title": "First smile"})
	uid := userID(t, a, email)
	a.CreateAPIKey(familyID, uid)
	a.CreateDevice(familyID, uid)
	return familyID, babyID, milestoneID
}

func addPhoto(t *testing.T, a *testrig.AppRig, familyID, milestoneID, id string) string {
	t.Helper()
	key := "milestone-photos/" + familyID + "/" + id + ".jpg"
	if _, err := a.Deps.Pool.Exec(context.Background(), `
		INSERT INTO "milestone_photo" ("id", "family_id", "milestone_log_id", "object_key", "width", "height", "size")
		VALUES ($1, $2, $3, $4, 10, 10, 4)`, id, familyID, milestoneID, key); err != nil {
		t.Fatalf("photo row: %v", err)
	}
	return key
}

func TestTableOrderPutsParentsFirst(t *testing.T) {
	a := testrig.App(t)
	order, err := restore.TableOrder(context.Background(), a.Deps.Pool)
	if err != nil {
		t.Fatalf("TableOrder: %v", err)
	}
	pos := map[string]int{}
	for i, name := range order {
		pos[name] = i
	}
	for _, pair := range [][2]string{
		{"users", "organization_members"},
		{"organizations", "organization_members"},
		{"organization_members", "organization_member_roles"},
		{"organizations", "baby"},
		{"baby", "feed_log"},
		{"medicine", "medicine_log"},
		{"milestone_log", "milestone_photo"},
		{"calendar_event", "calendar_assignee"},
		{"contact", "contact_baby"},
	} {
		if pos[pair[0]] >= pos[pair[1]] {
			t.Errorf("%s (at %d) must load before %s (at %d)", pair[0], pos[pair[0]], pair[1], pos[pair[1]])
		}
	}
}

// Back up a lived-in database, empty it, restore: every table as it was,
// but for the credentials the backup nulls and the sessions it cannot
// bring back.
func TestWholeRestoreRoundTrip(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, _, milestoneID := seedFamily(t, a, "Hansen", "parent@example.com")
	seedFamily(t, a, "Berg", "berg@example.com")
	photoKey := addPhoto(t, a, familyID, milestoneID, "p1")
	putObject(t, a, "photo-backups/current/"+familyID+"/p1.jpg", "jpeg")

	// What the snapshot will hold: no password, no OAuth token.
	if _, err := a.Deps.Pool.Exec(ctx, `
		UPDATE "users" SET "password" = NULL;
		UPDATE "accounts" SET "access_token" = NULL, "refresh_token" = NULL, "id_token" = NULL`); err != nil {
		t.Fatalf("null credentials: %v", err)
	}
	before := fingerprint(t, a)

	if _, err := jobs.RunBackup(ctx, jobsDeps(a), time.Date(2026, 9, 10, 3, 15, 0, 0, time.UTC)); err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	testrig.Setup(t) // an empty database, the tombstone reseeded

	snap, err := restore.FromStorage(ctx, a.Deps.Storage, "2026-09-10")
	if err != nil {
		t.Fatalf("FromStorage: %v", err)
	}
	rep, err := restore.Whole(ctx, restoreDeps(a), snap)
	if err != nil {
		t.Fatalf("Whole: %v", err)
	}

	after := fingerprint(t, a)
	for table, want := range before {
		if table == "sessions" {
			continue
		}
		if gone, extra := diffRows(t, want, after[table]); len(gone)+len(extra) > 0 {
			t.Errorf("%s differs after the round trip:\n only before: %v\n only after:  %v", table, gone, extra)
		}
	}
	if after["sessions"] != "[]" {
		t.Errorf("sessions came back: %.200s", after["sessions"])
	}
	if rep.Rows["feed_log"] != 2 || rep.Rows["organizations"] != 2 {
		t.Errorf("rows = %v, want two families and their feeds", rep.Rows)
	}
	if len(rep.Warnings) != 0 {
		t.Errorf("warnings = %v, want none for a snapshot from this build", rep.Warnings)
	}
	if body, ok := object(a, photoKey); !ok || body != "jpeg" || rep.PhotosRestored != 1 {
		t.Errorf("photo = %q %v (restored %d), want it back from the current tree", body, ok, rep.PhotosRestored)
	}
}

func TestWholeRestoreRefusesADatabaseInUse(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	empty := &restore.Snapshot{SchemaVersion: latest(t), Tables: map[string][]map[string]any{}}

	a.SignUp("Ada", "ada@example.com")
	if _, err := restore.Whole(ctx, restoreDeps(a), empty); !errors.Is(err, restore.ErrNotEmpty) {
		t.Errorf("with a real user = %v, want ErrNotEmpty", err)
	}

	testrig.Setup(t)
	if _, err := a.Deps.Pool.Exec(ctx, `INSERT INTO "organizations" ("id", "name", "slug") VALUES ('f', 'F', 'f')`); err != nil {
		t.Fatalf("seed family: %v", err)
	}
	if _, err := restore.Whole(ctx, restoreDeps(a), empty); !errors.Is(err, restore.ErrNotEmpty) {
		t.Errorf("with a family = %v, want ErrNotEmpty", err)
	}

	testrig.Setup(t)
	if _, err := restore.Whole(ctx, restoreDeps(a), empty); err != nil {
		t.Errorf("with only the tombstone = %v, want it to go ahead", err)
	}
}

func latest(t *testing.T) int64 {
	t.Helper()
	v, err := db.LatestMigrationVersion()
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func readSnapshot(t *testing.T, js string) *restore.Snapshot {
	t.Helper()
	snap, err := restore.Read(strings.NewReader(js))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	return snap
}

// A snapshot from another schema: a key the table no longer has, a column
// it did not have yet, a table since dropped.
func TestWholeRestoreToleratesSchemaDrift(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	snap := readSnapshot(t, fmt.Sprintf(`{"exportedAt":"2026-01-01T03:15:00Z","schemaVersion":%d,"tables":{
		"organizations":[{"id":"fam1","name":"Drift","slug":"drift"}],
		"baby":[{"id":"b1","family_id":"fam1","name":"Ada","birth_date":"2025-06-01T00:00:00Z","retired_column":"gone"}],
		"ancient_table":[{"id":"x"}]
	}}`, latest(t)))

	rep, err := restore.Whole(ctx, restoreDeps(a), snap)
	if err != nil {
		t.Fatalf("Whole: %v", err)
	}
	if len(rep.Skipped) != 1 || rep.Skipped[0] != "ancient_table" {
		t.Errorf("skipped = %v, want the dropped table", rep.Skipped)
	}
	var name string
	var createdSet bool
	if err := a.Deps.Pool.QueryRow(ctx,
		`SELECT "name", "created_at" IS NOT NULL FROM "baby" WHERE "id" = 'b1'`).Scan(&name, &createdSet); err != nil {
		t.Fatalf("baby: %v", err)
	}
	if name != "Ada" || !createdSet {
		t.Errorf("baby = %q (created_at set %v), want Ada with a defaulted created_at", name, createdSet)
	}
}

func TestWholeRestoreLoadsLargeTablesInChunks(t *testing.T) {
	a := testrig.App(t)
	var b strings.Builder
	for i := range 2500 {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"id":"b%d","family_id":"fam1","name":"Baby %d","birth_date":"2025-06-01T00:00:00Z"}`, i, i)
	}
	snap := readSnapshot(t, fmt.Sprintf(`{"schemaVersion":%d,"tables":{
		"organizations":[{"id":"fam1","name":"Many","slug":"many"}],
		"baby":[%s]}}`, latest(t), b.String()))

	rep, err := restore.Whole(context.Background(), restoreDeps(a), snap)
	if err != nil {
		t.Fatalf("Whole: %v", err)
	}
	var n int
	if err := a.Deps.Pool.QueryRow(context.Background(), `SELECT count(*) FROM "baby"`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2500 || rep.Rows["baby"] != 2500 {
		t.Errorf("babies = %d (reported %d), want 2500", n, rep.Rows["baby"])
	}
}

func TestWholeRestoreChecksTheSnapshotsSchemaVersion(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()

	old := readSnapshot(t, `{"tables":{}}`)
	rep, err := restore.Whole(ctx, restoreDeps(a), old)
	if err != nil || len(rep.Warnings) != 1 || !strings.Contains(rep.Warnings[0], "schema version") {
		t.Errorf("a snapshot without a version = %v, %v; want one warning", rep, err)
	}

	newer := readSnapshot(t, fmt.Sprintf(`{"schemaVersion":%d,"tables":{}}`, latest(t)+1))
	if _, err := restore.Whole(ctx, restoreDeps(a), newer); !errors.Is(err, restore.ErrNewerSnapshot) {
		t.Errorf("a snapshot from a newer schema = %v, want ErrNewerSnapshot", err)
	}
}

// Photos come back from the current tree, else the newest deleted tree; a
// photo in place is left alone, and one with no copy is reported.
func TestWholeRestorePutsPhotosBackFromTheBackupTrees(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, _, milestoneID := seedFamily(t, a, "Hansen", "parent@example.com")
	current := addPhoto(t, a, familyID, milestoneID, "current")
	deleted := addPhoto(t, a, familyID, milestoneID, "deleted")
	inPlace := addPhoto(t, a, familyID, milestoneID, "inplace")
	missing := addPhoto(t, a, familyID, milestoneID, "missing")

	putObject(t, a, "photo-backups/current/"+familyID+"/current.jpg", "current copy")
	putObject(t, a, "photo-backups/deleted/2026-09-01/"+familyID+"/deleted.jpg", "older copy")
	putObject(t, a, "photo-backups/deleted/2026-09-05/"+familyID+"/deleted.jpg", "newer copy")
	putObject(t, a, inPlace, "live")

	if _, err := jobs.RunBackup(ctx, jobsDeps(a), time.Date(2026, 9, 10, 3, 15, 0, 0, time.UTC)); err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	testrig.Setup(t)
	snap, err := restore.FromStorage(ctx, a.Deps.Storage, "2026-09-10")
	if err != nil {
		t.Fatal(err)
	}
	rep, err := restore.Whole(ctx, restoreDeps(a), snap)
	if err != nil {
		t.Fatalf("Whole: %v", err)
	}

	for key, want := range map[string]string{current: "current copy", deleted: "newer copy", inPlace: "live"} {
		if got, _ := object(a, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if rep.PhotosRestored != 2 || len(rep.PhotosMissing) != 1 || rep.PhotosMissing[0] != missing {
		t.Errorf("restored %d, missing %v; want 2 restored and %s missing", rep.PhotosRestored, rep.PhotosMissing, missing)
	}
}

func TestFromStorageWithoutASnapshot(t *testing.T) {
	a := testrig.App(t)
	if _, err := restore.FromStorage(context.Background(), a.Deps.Storage, "2020-01-01"); !errors.Is(err, restore.ErrNoSnapshot) {
		t.Errorf("err = %v, want ErrNoSnapshot", err)
	}
	if _, err := restore.Read(bytes.NewReader([]byte(`{"exportedAt":"x"}`))); err == nil {
		t.Error("a JSON document without tables read as a snapshot")
	}
}
