// Package restore puts a nightly snapshot back
// (docs/superpowers/specs/2026-09-11-admin-restore-design.md): the whole
// database into an empty one (Whole), or one deleted family into the live
// one (Family).
//
// Both share one loader, driven by the live schema rather than a
// hand-kept table list: the foreign keys set the order, and Postgres types
// every row itself through json_populate_recordset. A table added
// tomorrow is restored without anyone touching this package — and the
// family restore's guard test makes sure someone decides how a new table
// relates to a family.
package restore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/storage"
)

// Snapshot is a nightly backup, read back: every table's rows as the
// backup job dumped them. Numbers stay json.Number, so a value goes back
// in exactly as it came out.
type Snapshot struct {
	ExportedAt string
	// SchemaVersion is the goose version the snapshot was taken at; 0 for
	// snapshots written before the backup recorded it.
	SchemaVersion int64
	Tables        map[string][]map[string]any
}

// ErrNoSnapshot is a date with no snapshot in storage.
var ErrNoSnapshot = errors.New("restore: no snapshot for that date")

// Read parses a snapshot.
func Read(r io.Reader) (*Snapshot, error) {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	var raw struct {
		ExportedAt    string                      `json:"exportedAt"`
		SchemaVersion int64                       `json:"schemaVersion"`
		Tables        map[string][]map[string]any `json:"tables"`
	}
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("restore: read the snapshot: %w", err)
	}
	if raw.Tables == nil {
		return nil, errors.New("restore: not a snapshot: it has no tables")
	}
	return &Snapshot{ExportedAt: raw.ExportedAt, SchemaVersion: raw.SchemaVersion, Tables: raw.Tables}, nil
}

// FromStorage reads the snapshot the backup job wrote for date
// (YYYY-MM-DD) from the configured storage.
func FromStorage(ctx context.Context, st storage.Storage, date string) (*Snapshot, error) {
	rc, found, err := st.GetStream(ctx, jobs.SnapshotKey(date))
	if err != nil {
		return nil, fmt.Errorf("restore: open the snapshot for %s: %w", date, err)
	}
	if !found {
		return nil, ErrNoSnapshot
	}
	defer func() { _ = rc.Close() }()
	return Read(rc)
}

// FromFile reads a snapshot from disk — one downloaded from the console.
func FromFile(path string) (*Snapshot, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("restore: %w", err)
	}
	defer func() { _ = f.Close() }()
	return Read(f)
}
