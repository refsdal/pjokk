package jobs_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// The photo backup keeps one copy per live photo, moves the copy of a
// deleted photo into a dated tree the night after, and prunes that tree
// after the 30-day window — never touching "backups/" (the row dumps).
func TestRunPhotoBackupCopiesMovesAndPrunes(t *testing.T) {
	a := testrig.App(t)
	d := depsFor(a)
	mem := a.Deps.Storage.(*storage.Memory)
	ctx := context.Background()
	put := func(key string, body string) {
		t.Helper()
		if err := mem.Put(ctx, key, bytes.NewReader([]byte(body)), int64(len(body)), "image/jpeg"); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	put("milestone-photos/fam/a.jpg", "photo-a")
	put("milestone-photos/fam/b.jpg", "photo-b")
	put("backups/2026-03-01.json", "{}")

	night1 := time.Date(2026, 3, 16, 3, 15, 0, 0, time.UTC)
	copied, moved, pruned, err := jobs.RunPhotoBackup(ctx, d, night1)
	if err != nil {
		t.Fatalf("night 1: %v", err)
	}
	if copied != 2 || moved != 0 || pruned != 0 {
		t.Fatalf("night 1 = %d/%d/%d, want 2 copied, 0 moved, 0 pruned", copied, moved, pruned)
	}
	if got, ok := mem.Read("photo-backups/current/fam/a.jpg"); !ok || string(got) != "photo-a" {
		t.Errorf("current copy of a = %q (%v), want photo-a", got, ok)
	}

	// Nothing changed: the second night copies nothing again.
	if c, m, p, _ := jobs.RunPhotoBackup(ctx, d, night1.Add(24*time.Hour)); c != 0 || m != 0 || p != 0 {
		t.Fatalf("night 2 = %d/%d/%d, want all zero", c, m, p)
	}

	// The family deletes photo b; the next night its copy moves to the
	// dated tree and the current copy goes.
	if err := mem.Delete(ctx, "milestone-photos/fam/b.jpg"); err != nil {
		t.Fatal(err)
	}
	night3 := night1.Add(48 * time.Hour)
	if c, m, p, err := jobs.RunPhotoBackup(ctx, d, night3); err != nil || c != 0 || m != 1 || p != 0 {
		t.Fatalf("night 3 = %d/%d/%d (%v), want 0 copied, 1 moved, 0 pruned", c, m, p, err)
	}
	if _, ok := mem.Read("photo-backups/current/fam/b.jpg"); ok {
		t.Errorf("current copy of b still present after the move")
	}
	if got, ok := mem.Read("photo-backups/deleted/2026-03-18/fam/b.jpg"); !ok || string(got) != "photo-b" {
		t.Errorf("deleted copy of b = %q (%v), want photo-b under the night's date", got, ok)
	}

	// 29 days later it is still there; 31 days later it is pruned. a's
	// current copy and the row dump are never touched.
	if _, _, p, _ := jobs.RunPhotoBackup(ctx, d, night3.Add(29*24*time.Hour)); p != 0 {
		t.Errorf("pruned after 29 days = %d, want 0", p)
	}
	if _, _, p, _ := jobs.RunPhotoBackup(ctx, d, night3.Add(31*24*time.Hour)); p != 1 {
		t.Errorf("pruned after 31 days = %d, want 1", p)
	}
	if _, ok := mem.Read("photo-backups/deleted/2026-03-18/fam/b.jpg"); ok {
		t.Errorf("deleted copy of b survived the retention window")
	}
	if _, ok := mem.Read("photo-backups/current/fam/a.jpg"); !ok {
		t.Errorf("current copy of a was lost")
	}
	if _, ok := mem.Read("backups/2026-03-01.json"); !ok {
		t.Errorf("the row dump under backups/ was touched")
	}
}
