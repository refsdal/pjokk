package api_test

// The console's family restore (spec 2026-09-11-admin-restore §3).

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func backupTonight(t *testing.T, a *testrig.AppRig) {
	t.Helper()
	d := jobs.Deps{Pool: a.Deps.Pool, Q: a.Deps.Q, Storage: a.Deps.Storage, Push: a.Push, Now: a.Deps.Now}
	if _, err := jobs.RunBackup(context.Background(), d, time.Date(2026, 9, 10, 3, 15, 0, 0, time.UTC)); err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
}

// deletedByTheConsole makes a family, snapshots it, and deletes it the way
// an operator would.
func deletedByTheConsole(t *testing.T, a *testrig.AppRig, cookie string) string {
	t.Helper()
	familyID, _ := a.NewFamily("Hansen", "parent@example.com")
	a.NewBaby(familyID, "Nora")
	backupTonight(t, a)
	if res := a.Do(http.MethodDelete, "/api/admin/families/"+familyID, cookie, nil); res.Status/100 != 2 {
		t.Fatalf("delete family = %d %s", res.Status, res.Raw)
	}
	return familyID
}

func TestDeletedFamiliesSaysWhoDeletedThem(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	familyID := deletedByTheConsole(t, a, cookie)

	res := a.DoArray(http.MethodGet, "/api/admin/backups/2026-09-10/families", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("deleted families = %d %s", res.Status, res.Raw)
	}
	// The operator's own family is in the snapshot too, and alive.
	if len(res.JSON) != 1 {
		t.Fatalf("deleted families = %s, want Hansen alone", res.Raw)
	}
	f := res.JSON[0].(map[string]any)
	if f["id"] != familyID || f["name"] != "Hansen" || f["members"] != float64(1) || f["babies"] != float64(1) {
		t.Errorf("family = %v", f)
	}
	if f["deletedBy"] != "Rig admin" || f["deletedAt"] == nil {
		t.Errorf("deleted by %v at %v, want the operator and a time", f["deletedBy"], f["deletedAt"])
	}

	if res := a.Do(http.MethodGet, "/api/admin/backups/2020-01-01/families", cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("a night with no snapshot = %d, want 404", res.Status)
	}
}

func TestRestoreDeletedFamilyFromTheConsole(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Ops family")
	familyID := deletedByTheConsole(t, a, cookie)
	path := "/api/admin/backups/2026-09-10/families/" + familyID + "/restore"

	res := a.Do(http.MethodPost, path, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("restore = %d %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Hansen" || res.JSON["membersRejoined"] != float64(1) || res.JSON["hasAdmin"] != true {
		t.Errorf("report = %v", res.JSON)
	}
	if rows := res.JSON["rows"].(map[string]any); rows["baby"] != float64(1) {
		t.Errorf("rows = %v, want the baby back", rows)
	}

	// Back on its console page.
	if page := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil); page.Status != http.StatusOK || page.JSON["name"] != "Hansen" {
		t.Errorf("family page = %d %s", page.Status, page.Raw)
	}
	var detail string
	if err := a.Rig.Pool.QueryRow(context.Background(), `
		SELECT "detail" FROM "admin_audit" WHERE "admin_id" = $1 AND "action" = 'family.restore' AND "target" = $2`,
		adminID, familyID).Scan(&detail); err != nil {
		t.Fatalf("audit row: %v", err)
	}
	if !strings.Contains(detail, "2026-09-10") {
		t.Errorf("audit detail = %q, want the snapshot's date", detail)
	}

	// Once more: it exists now.
	if again := a.Do(http.MethodPost, path, cookie, nil); again.Status != http.StatusConflict || again.JSON["code"] != "FAMILY_EXISTS" {
		t.Errorf("restoring it twice = %d %s, want 409 FAMILY_EXISTS", again.Status, again.Raw)
	}
	if missing := a.Do(http.MethodPost, "/api/admin/backups/2026-09-10/families/no-such-family/restore", cookie, nil); missing.Status != http.StatusNotFound {
		t.Errorf("a family not in the snapshot = %d, want 404", missing.Status)
	}
	if bad := a.Do(http.MethodPost, "/api/admin/backups/latest/families/"+familyID+"/restore", cookie, nil); bad.Status != http.StatusBadRequest {
		t.Errorf("a malformed date = %d, want 400", bad.Status)
	}
}

// Issue #95: the console's delete erases a family's photos from the store,
// and the family restore still gets them back — from the photo backup's
// dated deleted tree, where the next night moves the family's copies.
func TestRestoredFamilyGetsItsPhotoBackAfterTheDeleteErasedIt(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	ctx := context.Background()
	mem := a.Deps.Storage.(*storage.Memory)

	familyID, parentCookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	up := photoUpload(t, a, newMilestone(t, a, parentCookie, babyID, "First smile"), parentCookie, realPNG(t, 40, 30))
	if up.Status != http.StatusCreated {
		t.Fatalf("upload = %d %s", up.Status, up.Raw)
	}
	var key string
	if err := a.Rig.Pool.QueryRow(ctx, `SELECT "object_key" FROM "milestone_photo" WHERE "id" = $1`, up.JSON["id"]).Scan(&key); err != nil {
		t.Fatalf("photo key: %v", err)
	}
	original, _ := mem.Read(key)

	d := jobs.Deps{Pool: a.Deps.Pool, Q: a.Deps.Q, Storage: a.Deps.Storage, Push: a.Push, Now: a.Deps.Now}
	backupTonight(t, a)
	night1 := time.Now().UTC().Add(2 * time.Hour)
	if _, err := jobs.RunPhotoBackup(ctx, d, night1); err != nil {
		t.Fatalf("photo backup, night 1: %v", err)
	}

	if res := a.Do(http.MethodDelete, "/api/admin/families/"+familyID, cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete family = %d %s", res.Status, res.Raw)
	}
	if _, ok := mem.Read(key); ok {
		t.Fatalf("the photo is still stored after its family was deleted")
	}
	night2 := night1.Add(24 * time.Hour)
	if res, err := jobs.RunPhotoBackup(ctx, d, night2); err != nil || res.Moved != 1 {
		t.Fatalf("photo backup, night 2 = %+v (%v), want the family's copy moved", res, err)
	}

	res := a.Do(http.MethodPost, "/api/admin/backups/2026-09-10/families/"+familyID+"/restore", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("restore = %d %s", res.Status, res.Raw)
	}
	if res.JSON["photosRestored"] != float64(1) {
		t.Errorf("photosRestored = %v, want 1 (report %s)", res.JSON["photosRestored"], res.Raw)
	}
	if got, ok := mem.Read(key); !ok || !bytes.Equal(got, original) {
		t.Errorf("the photo was not put back from the deleted tree (present %v)", ok)
	}
}
