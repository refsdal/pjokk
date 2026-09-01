package jobs_test

import (
	"context"
	"testing"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Ports apps/api/test/backup-tables.test.ts. This tests list *completeness*
// against the live schema — a different concern from backup_test.go, which
// tests backup *behaviour*.
//
// Every table the schema creates must be either backed up or deliberately
// excluded (jobs.DeliberatelyExcluded) — a table in neither set is silent
// data loss on restore.
func TestBackupTablesCoversEveryLiveTable(t *testing.T) {
	rig := testrig.Setup(t)

	tables, err := livePublicTables(t, rig)
	if err != nil {
		t.Fatalf("list live tables: %v", err)
	}

	covered := make(map[string]bool, len(jobs.BackupTables)+len(jobs.DeliberatelyExcluded))
	for _, tbl := range jobs.BackupTables {
		covered[tbl] = true
	}
	for tbl := range jobs.DeliberatelyExcluded {
		covered[tbl] = true
	}

	var uncovered []string
	for _, tbl := range tables {
		if !covered[tbl] {
			uncovered = append(uncovered, tbl)
		}
	}
	if len(uncovered) != 0 {
		t.Errorf("tables neither backed up nor deliberately excluded: %v", uncovered)
	}
}

func TestBackupTablesHasNoStaleEntry(t *testing.T) {
	rig := testrig.Setup(t)

	tables, err := livePublicTables(t, rig)
	if err != nil {
		t.Fatalf("list live tables: %v", err)
	}
	live := make(map[string]bool, len(tables))
	for _, tbl := range tables {
		live[tbl] = true
	}

	var stale []string
	for _, tbl := range jobs.BackupTables {
		if !live[tbl] {
			stale = append(stale, tbl)
		}
	}
	if len(stale) != 0 {
		t.Errorf("jobs.BackupTables names tables no longer in the schema: %v", stale)
	}
}

func livePublicTables(t *testing.T, rig *testrig.Rig) ([]string, error) {
	t.Helper()
	rows, err := rig.Pool.Query(context.Background(),
		`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}
