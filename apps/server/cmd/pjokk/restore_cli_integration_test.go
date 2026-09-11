package main

// The restore commands end to end, against the test database: the same
// config, migration, dependency building and restore the container runs.

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func useTestConfig(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", testrig.DatabaseURL())
	t.Setenv("APP_URL", "http://localhost:3300")
	t.Setenv("AUTH_SECRET", "restore-cli-test-secret-restore-cli-test-secret")
	t.Setenv("STORAGE_DRIVER", "fs")
	t.Setenv("STORAGE_FS_PATH", t.TempDir())
	t.Setenv("OPEN_SIGNUP", "")
}

// snapshotFile writes tonight's snapshot of the rig's database to a file,
// as someone who downloaded it from the console would have it.
func snapshotFile(t *testing.T, a *testrig.AppRig) string {
	t.Helper()
	d := jobs.Deps{Pool: a.Deps.Pool, Q: a.Deps.Q, Storage: a.Deps.Storage, Push: a.Push, Now: a.Deps.Now}
	key, err := jobs.RunBackup(context.Background(), d, time.Date(2026, 9, 10, 3, 15, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	body, ok := a.Deps.Storage.(*storage.Memory).Read(key)
	if !ok {
		t.Fatal("no snapshot written")
	}
	path := filepath.Join(t.TempDir(), "pjokk-backup-2026-09-10.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func countFamilies(t *testing.T, a *testrig.AppRig) int {
	t.Helper()
	var n int
	if err := a.Deps.Pool.QueryRow(context.Background(), `SELECT count(*) FROM "organizations"`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRestoreCommandsAgainstTheDatabase(t *testing.T) {
	a := testrig.App(t)
	familyID, _ := a.NewFamily("Hansen", "parent@example.com")
	a.NewBaby(familyID, "Nora")
	path := snapshotFile(t, a)

	testrig.Setup(t) // an empty database
	useTestConfig(t)

	if code := restoreMode([]string{"--file", path}); code != 0 {
		t.Fatalf("restore --file = %d, want 0", code)
	}
	if n := countFamilies(t, a); n != 1 {
		t.Fatalf("families after the restore = %d, want 1", n)
	}
	// Run again: the database is in use now, and the restore refuses.
	if code := restoreMode([]string{"--file", path}); code != 1 {
		t.Errorf("a second restore = %d, want 1 (the database is not empty)", code)
	}

	// No password came back; the operator sets one and signs in with it.
	if code := setPasswordMode([]string{"Parent@Example.com"}, strings.NewReader("Correct-Horse-Battery-9\n")); code != 0 {
		t.Fatalf("set-password = %d, want 0", code)
	}
	res := a.Do(http.MethodPost, "/api/auth/signin/credential", "", map[string]string{
		"credential": "parent@example.com", "password": "Correct-Horse-Battery-9",
	})
	if res.Status != http.StatusOK {
		t.Errorf("sign in with the new password = %d %s", res.Status, res.Raw)
	}
	if code := setPasswordMode([]string{"nobody@example.com"}, strings.NewReader("Correct-Horse-Battery-9\n")); code != 1 {
		t.Errorf("set-password for no account = %d, want 1", code)
	}

	// And one family, deleted by mistake, back from the same file.
	if _, err := a.Deps.Pool.Exec(context.Background(), `DELETE FROM "organizations" WHERE "id" = $1`, familyID); err != nil {
		t.Fatal(err)
	}
	if code := restoreMode([]string{"family", familyID, "--file", path}); code != 0 {
		t.Fatalf("restore family = %d, want 0", code)
	}
	if n := countFamilies(t, a); n != 1 {
		t.Errorf("families after the family restore = %d, want 1", n)
	}
	if code := restoreMode([]string{"family", familyID, "--file", path}); code != 1 {
		t.Errorf("restoring a family that exists = %d, want 1", code)
	}
}
