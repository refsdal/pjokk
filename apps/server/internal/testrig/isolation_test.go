package testrig_test

import (
	"context"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Two tests, two databases: a row one writes is invisible to the other,
// which is what makes t.Parallel safe everywhere the rig is used.
func TestEachTestGetsItsOwnDatabase(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	a := testrig.Setup(t)
	b := testrig.Setup(t)
	if a.URL == b.URL {
		t.Fatalf("both rigs point at %s", a.URL)
	}
	if _, err := a.Pool.Exec(ctx, `INSERT INTO "organizations" ("id", "name", "slug") VALUES ('f', 'F', 'f')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var n int
	if err := b.Pool.QueryRow(ctx, `SELECT count(*) FROM "organizations"`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("the other database sees %d organizations, want 0", n)
	}
	// Empty is this test's database only.
	a.Empty(t)
	if err := a.Pool.QueryRow(ctx, `SELECT count(*) FROM "organizations"`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("after Empty: %d organizations, err %v", n, err)
	}
}

func TestTheURLIsPlainAndTheDatabaseIsMigrated(t *testing.T) {
	t.Parallel()
	r := testrig.Setup(t)
	if u := r.URL; len(u) == 0 || contains(u, "pool_max_conns") {
		t.Fatalf("URL = %q, want a plain URL for database/sql", u)
	}
	var v int64
	if err := r.Pool.QueryRow(context.Background(), `SELECT max("version_id") FROM "goose_db_version"`).Scan(&v); err != nil || v == 0 {
		t.Fatalf("migrations: version %d, err %v", v, err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
