package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// TestTimestamptzScansInUTC guards the ScanLocation pin in db.New. pgx 5.12
// began returning timestamptz in time.Local from the text format, which put
// the host's zone on every timestamp the API marshals; the scratch image sets
// no TZ, so only a developer's machine would have shown it.
//
// Deliberately not parallel: it swaps the process-wide time.Local so the test
// means something on a UTC CI runner too. Go runs a package's non-parallel
// tests before releasing the parallel ones, so nothing else observes the swap.
func TestTimestamptzScansInUTC(t *testing.T) {
	oslo, err := time.LoadLocation("Europe/Oslo")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	prev := time.Local
	time.Local = oslo
	t.Cleanup(func() { time.Local = prev })

	ctx := context.Background()
	rig := testrig.Setup(t)

	const q = `SELECT '2026-03-15 10:00:00+01'::timestamptz`
	for name, args := range map[string][]any{
		"binary": nil,
		"text":   {pgx.QueryExecModeSimpleProtocol},
	} {
		var got time.Time
		if err := rig.Pool.QueryRow(ctx, q, args...).Scan(&got); err != nil {
			t.Fatalf("%s: scan: %v", name, err)
		}
		if got.Location() != time.UTC {
			t.Errorf("%s: location = %v, want UTC", name, got.Location())
		}
		if want := time.Date(2026, 3, 15, 9, 0, 0, 0, time.UTC); !got.Equal(want) {
			t.Errorf("%s: instant = %v, want %v", name, got, want)
		}
	}
}
