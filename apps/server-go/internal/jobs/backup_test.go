package jobs_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// depsFor builds jobs.Deps from an AppRig's own collaborators — the same
// Pool/Q/Storage/Push an api.Deps uses, so a job test can create fixtures
// through real HTTP routes (a.Do) and then run the job function directly
// against the same database and storage.
func depsFor(a *testrig.AppRig) jobs.Deps {
	return jobs.Deps{
		Pool:    a.Deps.Pool,
		Q:       a.Deps.Q,
		Storage: a.Deps.Storage,
		Push:    a.Push,
		Now:     a.Deps.Now,
	}
}

type backupSnapshot struct {
	ExportedAt string                      `json:"exportedAt"`
	Tables     map[string][]map[string]any `json:"tables"`
}

// Ports apps/api/test/backup.test.ts's "writes a dated JSON snapshot of
// every table to object storage".
func TestRunBackupWritesADatedSnapshotOfEveryTable(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	feedRes := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 130,
	})
	if feedRes.Status != http.StatusCreated {
		t.Fatalf("create feed status = %d, body %s", feedRes.Status, feedRes.Raw)
	}

	locRes := a.Do(http.MethodPost, "/api/sleep-locations", cookie, map[string]any{"name": "Hammock"})
	if locRes.Status != http.StatusCreated {
		t.Fatalf("create sleep location status = %d, body %s", locRes.Status, locRes.Raw)
	}

	d := depsFor(a)
	now := time.Date(2026, 8, 24, 3, 15, 0, 0, time.UTC)
	key, err := jobs.RunBackup(context.Background(), d, now)
	if err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	if key != "backups/2026-08-24.json" {
		t.Errorf("key = %q, want %q", key, "backups/2026-08-24.json")
	}

	mem := d.Storage.(*storage.Memory)
	raw, ok := mem.Read(key)
	if !ok {
		t.Fatalf("no object written at %q", key)
	}

	var snap backupSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}

	if len(snap.Tables["users"]) == 0 {
		t.Errorf("tables.users is empty, want at least the rig admin")
	}
	if got := len(snap.Tables["feed_log"]); got != 1 {
		t.Errorf("tables.feed_log has %d rows, want 1", got)
	}
	if _, ok := snap.Tables["push_subscription"]; !ok {
		t.Errorf("tables does not contain push_subscription")
	}
	locRows := snap.Tables["sleep_location"]
	if len(locRows) != 1 {
		t.Fatalf("tables.sleep_location has %d rows, want 1", len(locRows))
	}
	if name, _ := locRows[0]["name"].(string); name != "Hammock" {
		t.Errorf("sleep_location[0].name = %v, want %q", locRows[0]["name"], "Hammock")
	}
}

// Ports the "backup retention" describe block of backup.test.ts.
func TestPruneBackupsDeletesStaleSnapshotsAndKeepsTheRest(t *testing.T) {
	a := testrig.App(t)
	d := depsFor(a)
	mem := d.Storage.(*storage.Memory)
	ctx := context.Background()

	now := time.Date(2026, 8, 27, 3, 15, 0, 0, time.UTC)
	day := func(offsetDays int) string {
		return now.Add(-time.Duration(offsetDays) * 24 * time.Hour).Format("2006-01-02")
	}

	fresh := "backups/" + day(1) + ".json"
	edge := "backups/" + day(29) + ".json" // BACKUP_RETENTION_DAYS - 1
	stale := "backups/" + day(31) + ".json"
	ancient := "backups/2020-01-01.json"

	for _, key := range []string{fresh, edge, stale, ancient} {
		if err := mem.Put(ctx, key, jsonBody(), 2, "application/json"); err != nil {
			t.Fatalf("seed %q: %v", key, err)
		}
	}

	removed, err := jobs.PruneBackups(ctx, d, now)
	if err != nil {
		t.Fatalf("PruneBackups: %v", err)
	}
	assertSameSet(t, removed, []string{ancient, stale})

	left := listKeys(t, mem, "backups/")
	assertContains(t, left, fresh)
	assertContains(t, left, edge)
	assertNotContains(t, left, stale)
	assertNotContains(t, left, ancient)
}

func TestPruneBackupsNeverTouchesAnythingOutsideThePrefix(t *testing.T) {
	a := testrig.App(t)
	d := depsFor(a)
	mem := d.Storage.(*storage.Memory)
	ctx := context.Background()

	now := time.Date(2026, 8, 27, 3, 15, 0, 0, time.UTC)

	// A vaccine document is far older than the window and must survive:
	// retention applies to snapshots, not to a family's own files.
	if err := mem.Put(ctx, "vaccine-docs/fam_x/some-file", jsonBody(), 2, "application/octet-stream"); err != nil {
		t.Fatalf("seed vaccine doc: %v", err)
	}
	if err := mem.Put(ctx, "backups/2019-05-05.json", jsonBody(), 2, "application/json"); err != nil {
		t.Fatalf("seed ancient backup: %v", err)
	}

	removed, err := jobs.PruneBackups(ctx, d, now)
	if err != nil {
		t.Fatalf("PruneBackups: %v", err)
	}
	assertSameSet(t, removed, []string{"backups/2019-05-05.json"})

	if _, ok := mem.Read("vaccine-docs/fam_x/some-file"); !ok {
		t.Errorf("vaccine document was deleted by backup retention")
	}
}

func TestPruneBackupsIsANoOpWhenEverySnapshotIsRecent(t *testing.T) {
	a := testrig.App(t)
	d := depsFor(a)
	mem := d.Storage.(*storage.Memory)
	ctx := context.Background()

	now := time.Date(2026, 8, 27, 3, 15, 0, 0, time.UTC)
	if err := mem.Put(ctx, "backups/2026-08-26.json", jsonBody(), 2, "application/json"); err != nil {
		t.Fatalf("seed recent backup: %v", err)
	}

	removed, err := jobs.PruneBackups(ctx, d, now)
	if err != nil {
		t.Fatalf("PruneBackups: %v", err)
	}
	if len(removed) != 0 {
		t.Errorf("removed = %v, want none", removed)
	}
}
