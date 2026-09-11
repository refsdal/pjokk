package restore

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/storage"
)

// Deps is what a restore touches: the database and the object store the
// photos come back to.
type Deps struct {
	Pool    *pgxpool.Pool
	Storage storage.Storage
}

// Report says what a restore did, for the CLI to print and the console to
// show.
type Report struct {
	// SchemaVersion is the snapshot's (0: unknown); BuildVersion is this
	// binary's newest migration.
	SchemaVersion int64
	BuildVersion  int64
	// Rows is how many rows went into each table.
	Rows map[string]int64
	// Skipped names snapshot tables the schema no longer has.
	Skipped        []string
	PhotosRestored int
	// PhotosMissing names photo objects with no copy in either backup tree.
	PhotosMissing []string
	Warnings      []string
}

var (
	// ErrNotEmpty refuses a whole restore into a database already in use.
	ErrNotEmpty = errors.New("restore: the database is not empty — point DATABASE_URL at a fresh database and run the restore there")
	// ErrNewerSnapshot refuses a snapshot from a schema this build does not
	// know: its extra columns would be dropped without a word.
	ErrNewerSnapshot = errors.New("restore: the snapshot is from a newer schema than this build — restore it with a build at least that new")
)

// neverRestored are snapshot tables whose rows cannot go back, with why.
var neverRestored = map[string]string{
	"sessions": "its tokens are nulled in the snapshot and the column is required; a restore signs everyone out anyway",
}

// Whole loads snap into an empty, migrated database: every table in one
// transaction, then the milestone photos back into storage. "Empty" means
// no family and no user but the tombstone migrations seed — the refusal is
// what stops a mistyped DATABASE_URL from mixing a snapshot into live data.
//
// That seeded tombstone is deleted first, inside the transaction (nothing
// can reference it in an empty database), so the snapshot's own loads in
// its place and the round trip is exact; it is re-seeded afterwards for a
// snapshot that somehow lacks one.
func Whole(ctx context.Context, d Deps, snap *Snapshot) (*Report, error) {
	rep, err := newReport(snap)
	if err != nil {
		return nil, err
	}

	var inUse bool
	if err := d.Pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM "organizations")
		    OR EXISTS (SELECT 1 FROM "users" WHERE "id" <> $1)`, db.TombstoneID,
	).Scan(&inUse); err != nil {
		return nil, fmt.Errorf("restore: check the database is empty: %w", err)
	}
	if inUse {
		return nil, ErrNotEmpty
	}

	s, err := readSchema(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	for name := range snap.Tables {
		if s.tables[name] == nil {
			rep.Skipped = append(rep.Skipped, name)
		}
	}
	sort.Strings(rep.Skipped)

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("restore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM "users" WHERE "id" = $1`, db.TombstoneID); err != nil {
		return nil, fmt.Errorf("restore: clear the seeded tombstone: %w", err)
	}
	for _, name := range s.order {
		rows, ok := snap.Tables[name]
		if !ok || neverRestored[name] != "" {
			continue
		}
		n, err := insertRows(ctx, tx, s.tables[name], rows)
		if err != nil {
			return nil, err
		}
		rep.Rows[name] = n
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("restore: commit: %w", err)
	}
	if err := db.EnsureTombstone(ctx, d.Pool); err != nil {
		return nil, err
	}

	rep.PhotosRestored, rep.PhotosMissing, err = restorePhotos(ctx, d.Storage, photoKeys(snap.Tables["milestone_photo"]))
	if err != nil {
		return rep, err
	}
	return rep, nil
}

func newReport(snap *Snapshot) (*Report, error) {
	latest, err := db.LatestMigrationVersion()
	if err != nil {
		return nil, err
	}
	rep := &Report{SchemaVersion: snap.SchemaVersion, BuildVersion: latest, Rows: map[string]int64{}}
	switch {
	case snap.SchemaVersion > latest:
		return nil, fmt.Errorf("%w (snapshot %d, build %d)", ErrNewerSnapshot, snap.SchemaVersion, latest)
	case snap.SchemaVersion == 0:
		rep.Warnings = append(rep.Warnings,
			"the snapshot does not record its schema version (it predates that); columns added since take their defaults")
	case snap.SchemaVersion < latest:
		rep.Warnings = append(rep.Warnings, fmt.Sprintf(
			"the snapshot is from schema %d and this build is at %d; columns added since take their defaults", snap.SchemaVersion, latest))
	}
	return rep, nil
}
