package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// insertFamily inserts a minimal organizations row directly (sqlc has no
// CreateFamily query — families are created through internal/auth, which
// owns Limen's organization tables) so tests have a family to hang
// family-scoped rows off. Ownership is expressed by organization_members,
// not a column on organizations: 00002 dropped the guessed user_id column
// that Limen never writes.
func insertFamily(t *testing.T, ctx context.Context, rig *testrig.Rig, id, slug string) {
	t.Helper()
	_, err := rig.Pool.Exec(ctx,
		`INSERT INTO "organizations" ("id", "name", "slug") VALUES ($1, $2, $3)`,
		id, "Test Family "+id, slug,
	)
	if err != nil {
		t.Fatalf("insertFamily: %v", err)
	}
}

func countBabies(t *testing.T, ctx context.Context, rig *testrig.Rig) int {
	t.Helper()
	var n int
	if err := rig.Pool.QueryRow(ctx, `SELECT COUNT(*)::int FROM "baby"`).Scan(&n); err != nil {
		t.Fatalf("count babies: %v", err)
	}
	return n
}

// The next two tests prove the rig actually isolates: they run in source
// order (Go's default, no -shuffle), the first seeds a row and the second
// must see none of it. If Setup ever stopped truncating between tests, the
// second test would fail with a leaked row from the first.

func TestRigTruncation_A_SeedsARow(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	insertFamily(t, ctx, rig, "fam-truncation-a", "family-truncation-a")

	_, err := rig.Q.CreateBaby(ctx, gen.CreateBabyParams{
		FamilyID:  "fam-truncation-a",
		Name:      "Truncation Baby",
		BirthDate: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	})
	if err != nil {
		t.Fatalf("CreateBaby: %v", err)
	}

	if got := countBabies(t, ctx, rig); got != 1 {
		t.Fatalf("expected 1 baby after seeding, got %d", got)
	}
}

func TestRigTruncation_B_SeesAnEmptyRig(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	if got := countBabies(t, ctx, rig); got != 0 {
		t.Fatalf("expected the rig to have truncated the previous test's row, found %d babies", got)
	}
}

func TestIsUniqueViolation_TrueOnDuplicateSlug(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	insertFamily(t, ctx, rig, "fam-dup-slug-1", "dup-slug")

	_, err := rig.Pool.Exec(ctx,
		`INSERT INTO "organizations" ("id", "name", "slug") VALUES ($1, $2, $3)`,
		"fam-dup-slug-2", "Test Family fam-dup-slug-2", "dup-slug",
	)
	if err == nil {
		t.Fatalf("expected a duplicate-slug insert to fail")
	}
	if !db.IsUniqueViolation(err) {
		t.Fatalf("expected IsUniqueViolation to be true for a duplicate slug, got err=%v", err)
	}
}

func TestIsUniqueViolation_FalseOnForeignKeyViolation(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	_, err := rig.Q.CreateBaby(ctx, gen.CreateBabyParams{
		FamilyID:  "fam-does-not-exist",
		Name:      "Orphan Baby",
		BirthDate: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	})
	if err == nil {
		t.Fatalf("expected creating a baby under a nonexistent family to fail")
	}
	if db.IsUniqueViolation(err) {
		t.Fatalf("expected IsUniqueViolation to be false for a foreign-key violation, got err=%v", err)
	}
}

func TestEnsureTombstone_Idempotent(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	// testrig.Setup already calls EnsureTombstone once; call it again
	// directly to prove a second call is a genuine no-op, not an error.
	if err := db.EnsureTombstone(ctx, rig.Pool); err != nil {
		t.Fatalf("second EnsureTombstone call: %v", err)
	}
	if err := db.EnsureTombstone(ctx, rig.Pool); err != nil {
		t.Fatalf("third EnsureTombstone call: %v", err)
	}

	var n int
	if err := rig.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int FROM "users" WHERE "id" = $1`, db.TombstoneID,
	).Scan(&n); err != nil {
		t.Fatalf("count tombstone rows: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 tombstone user row, got %d", n)
	}
}
