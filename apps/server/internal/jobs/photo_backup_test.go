package jobs_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// photoRig is a family with one milestone to hang photo rows on. The photo
// backup reads "live" from milestone_photo rows, so a test stores a
// photo's object and its row separately and says which a photo has.
type photoRig struct {
	t         *testing.T
	a         *testrig.AppRig
	mem       *storage.Memory
	familyID  string
	milestone string
}

func newPhotoRig(t *testing.T) *photoRig {
	t.Helper()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	res := a.Do(http.MethodPost, "/api/milestones", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "title": "First smile",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create milestone: %d %s", res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	return &photoRig{t: t, a: a, mem: a.Deps.Storage.(*storage.Memory), familyID: familyID, milestone: id}
}

// key is the source key of the photo called name; rest is the same key
// without the source prefix, as the backup trees spell it.
func (p *photoRig) key(name string) string {
	return "milestone-photos/" + p.familyID + "/" + name + ".jpg"
}
func (p *photoRig) rest(name string) string { return p.familyID + "/" + name + ".jpg" }

func (p *photoRig) object(name string) {
	p.t.Helper()
	body := "photo-" + name
	if err := p.mem.Put(context.Background(), p.key(name), bytes.NewReader([]byte(body)), int64(len(body)), "image/jpeg"); err != nil {
		p.t.Fatalf("seed object %s: %v", name, err)
	}
}

func (p *photoRig) row(name string) {
	p.t.Helper()
	if _, err := p.a.Deps.Pool.Exec(context.Background(), `
		INSERT INTO "milestone_photo" ("id", "family_id", "milestone_log_id", "object_key", "width", "height", "size")
		VALUES ($1, $2, $3, $4, 10, 10, 7)`, name, p.familyID, p.milestone, p.key(name)); err != nil {
		p.t.Fatalf("seed row %s: %v", name, err)
	}
}

func (p *photoRig) dropRow(name string) {
	p.t.Helper()
	if _, err := p.a.Deps.Pool.Exec(context.Background(), `DELETE FROM "milestone_photo" WHERE "id" = $1`, name); err != nil {
		p.t.Fatalf("drop row %s: %v", name, err)
	}
}

func (p *photoRig) has(key string) bool {
	_, ok := p.mem.Read(key)
	return ok
}

func (p *photoRig) run(now time.Time) jobs.PhotoBackupResult {
	p.t.Helper()
	res, err := jobs.RunPhotoBackup(context.Background(), depsFor(p.a), now)
	if err != nil {
		p.t.Fatalf("RunPhotoBackup at %s: %v", now, err)
	}
	return res
}

// The photo backup keeps one copy per live photo, moves the copy of a
// deleted photo into a dated tree the night after, and prunes that tree
// after the 30-day window — never touching "backups/" (the row dumps).
func TestRunPhotoBackupCopiesMovesAndPrunes(t *testing.T) {
	p := newPhotoRig(t)
	ctx := context.Background()
	for _, name := range []string{"a", "b"} {
		p.object(name)
		p.row(name)
	}
	if err := p.mem.Put(ctx, "backups/2026-03-01.json", bytes.NewReader([]byte("{}")), 2, "application/json"); err != nil {
		t.Fatal(err)
	}

	night1 := time.Date(2026, 3, 16, 3, 15, 0, 0, time.UTC)
	if got := p.run(night1); got != (jobs.PhotoBackupResult{Copied: 2}) {
		t.Fatalf("night 1 = %+v, want 2 copied", got)
	}
	if got, ok := p.mem.Read("photo-backups/current/" + p.rest("a")); !ok || string(got) != "photo-a" {
		t.Errorf("current copy of a = %q (%v), want photo-a", got, ok)
	}

	// Nothing changed: the second night copies nothing again.
	if got := p.run(night1.Add(24 * time.Hour)); got != (jobs.PhotoBackupResult{}) {
		t.Fatalf("night 2 = %+v, want all zero", got)
	}

	// The family deletes photo b (the row, then the object, as the photo
	// route does); the next night its copy moves to the dated tree and the
	// current copy goes.
	p.dropRow("b")
	if err := p.mem.Delete(ctx, p.key("b")); err != nil {
		t.Fatal(err)
	}
	night3 := night1.Add(48 * time.Hour)
	if got := p.run(night3); got != (jobs.PhotoBackupResult{Moved: 1}) {
		t.Fatalf("night 3 = %+v, want 1 moved", got)
	}
	if p.has("photo-backups/current/" + p.rest("b")) {
		t.Errorf("current copy of b still present after the move")
	}
	if got, ok := p.mem.Read("photo-backups/deleted/2026-03-18/" + p.rest("b")); !ok || string(got) != "photo-b" {
		t.Errorf("deleted copy of b = %q (%v), want photo-b under the night's date", got, ok)
	}

	// 29 days later it is still there; 31 days later it is pruned. a's
	// current copy and the row dump are never touched.
	if got := p.run(night3.Add(29 * 24 * time.Hour)); got.Pruned != 0 {
		t.Errorf("pruned after 29 days = %d, want 0", got.Pruned)
	}
	if got := p.run(night3.Add(31 * 24 * time.Hour)); got.Pruned != 1 {
		t.Errorf("pruned after 31 days = %d, want 1", got.Pruned)
	}
	if p.has("photo-backups/deleted/2026-03-18/" + p.rest("b")) {
		t.Errorf("deleted copy of b survived the retention window")
	}
	if !p.has("photo-backups/current/" + p.rest("a")) {
		t.Errorf("current copy of a was lost")
	}
	if !p.has("backups/2026-03-01.json") {
		t.Errorf("the row dump under backups/ was touched")
	}
}

// Issue #95: "live" is a photo ROW, not an object in the store. A source
// object whose row is gone (a family or baby delete that removed the rows
// but not the objects) is erased from the source prefix, its copy moves
// to the dated tree like any deleted photo's, and the 30-day prune
// reaches it.
func TestRunPhotoBackupErasesAnOrphanedPhotoObject(t *testing.T) {
	p := newPhotoRig(t)
	for _, name := range []string{"kept", "orphan"} {
		p.object(name)
		p.row(name)
	}
	// Memory stamps an object with the wall clock, so the job's clock runs
	// from there: two hours on, nothing is mid-upload any more.
	night1 := time.Now().UTC().Add(2 * time.Hour)
	if got := p.run(night1); got != (jobs.PhotoBackupResult{Copied: 2}) {
		t.Fatalf("night 1 = %+v, want 2 copied", got)
	}

	p.dropRow("orphan") // the row goes; the object is left behind
	night2 := night1.Add(24 * time.Hour)
	if got := p.run(night2); got != (jobs.PhotoBackupResult{Moved: 1, Orphaned: 1}) {
		t.Fatalf("night 2 = %+v, want 1 moved, 1 orphan erased", got)
	}
	deletedCopy := "photo-backups/deleted/" + night2.Format("2006-01-02") + "/" + p.rest("orphan")
	if p.has(p.key("orphan")) {
		t.Errorf("the orphaned source object is still stored")
	}
	if p.has("photo-backups/current/" + p.rest("orphan")) {
		t.Errorf("the orphan's current copy was not moved")
	}
	if got, ok := p.mem.Read(deletedCopy); !ok || string(got) != "photo-orphan" {
		t.Errorf("deleted copy = %q (%v), want photo-orphan under the night's date", got, ok)
	}
	if !p.has(p.key("kept")) || !p.has("photo-backups/current/"+p.rest("kept")) {
		t.Errorf("the photo that still has a row lost its object or its copy")
	}

	if got := p.run(night2.Add(29 * 24 * time.Hour)); got.Pruned != 0 {
		t.Errorf("pruned after 29 days = %d, want 0", got.Pruned)
	}
	if got := p.run(night2.Add(31 * 24 * time.Hour)); got.Pruned != 1 {
		t.Errorf("pruned after 31 days = %d, want 1", got.Pruned)
	}
	if p.has(deletedCopy) {
		t.Errorf("the orphan's deleted copy survived the retention window")
	}
}

// The upload route stores the object before it inserts the row, so an
// object with no row may be a photo mid-upload. A fresh one is left
// alone; once it is old enough that no upload is still running, it is an
// orphan — and one that was never backed up goes straight into the dated
// tree, so the 30-day clock starts for it too.
func TestRunPhotoBackupSparesAPhotoMidUpload(t *testing.T) {
	p := newPhotoRig(t)
	p.object("uploading")

	if got := p.run(time.Now().UTC()); got != (jobs.PhotoBackupResult{}) {
		t.Fatalf("mid-upload run = %+v, want all zero", got)
	}
	if !p.has(p.key("uploading")) {
		t.Fatalf("a photo mid-upload was erased")
	}

	later := time.Now().UTC().Add(2 * time.Hour)
	if got := p.run(later); got != (jobs.PhotoBackupResult{Moved: 1, Orphaned: 1}) {
		t.Fatalf("later run = %+v, want 1 moved, 1 orphan erased", got)
	}
	if p.has(p.key("uploading")) {
		t.Errorf("the stale orphan is still stored")
	}
	if got, ok := p.mem.Read("photo-backups/deleted/" + later.Format("2006-01-02") + "/" + p.rest("uploading")); !ok || string(got) != "photo-uploading" {
		t.Errorf("deleted copy = %q (%v), want the orphan's bytes under the night's date", got, ok)
	}
}
