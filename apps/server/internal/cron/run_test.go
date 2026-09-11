package cron

// Every run leaves a job_run row wherever it ran, and a job never overlaps
// itself (docs/superpowers/specs/2026-09-11-admin-ops-design.md §1). The
// rows are read with plain SQL rather than the generated queries so these
// tests say what is in the table, not what one query makes of it.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

type runRow struct {
	id       string
	trigger  string
	finished bool
	ok       *bool
	errText  *string
}

func runsOf(t *testing.T, pool *pgxpool.Pool, job string) []runRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT "id", "trigger", "finished_at" IS NOT NULL, "ok", "error"
		FROM "job_run" WHERE "job" = $1 ORDER BY "started_at" DESC, "id" DESC`, job)
	if err != nil {
		t.Fatalf("read job_run: %v", err)
	}
	defer rows.Close()
	var out []runRow
	for rows.Next() {
		var r runRow
		if err := rows.Scan(&r.id, &r.trigger, &r.finished, &r.ok, &r.errText); err != nil {
			t.Fatalf("scan job_run: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// withBody swaps the job body for the length of one test.
func withBody(t *testing.T, body func(context.Context, string, Deps) error) {
	t.Helper()
	jobBody = body
	t.Cleanup(func() { jobBody = RunJob })
}

func TestRunRecordsASuccessfulRun(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)

	id, err := Run(context.Background(), "frequent", "cli", d)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	runs := runsOf(t, a.Deps.Pool, "frequent")
	if len(runs) != 1 {
		t.Fatalf("runs = %+v, want one", runs)
	}
	r := runs[0]
	if r.id != id || r.trigger != "cli" || !r.finished || r.ok == nil || !*r.ok || r.errText != nil {
		t.Errorf("run = %+v (id %q), want a finished ok cli run with no error", r, id)
	}
}

func TestRunRecordsAFailure(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)
	withBody(t, func(context.Context, string, Deps) error {
		return errors.New("storage unreachable")
	})

	if _, err := Run(context.Background(), "nightly", "schedule", d); err == nil || err.Error() != "storage unreachable" {
		t.Fatalf("Run err = %v, want the job's own error", err)
	}
	runs := runsOf(t, a.Deps.Pool, "nightly")
	if len(runs) != 1 || runs[0].ok == nil || *runs[0].ok || runs[0].errText == nil || *runs[0].errText != "storage unreachable" {
		t.Fatalf("runs = %+v, want one failed run carrying the error", runs)
	}
	if runs[0].trigger != "schedule" {
		t.Errorf("trigger = %q, want schedule", runs[0].trigger)
	}
}

// A panicking job is a failed run, not a dead process.
func TestRunRecordsAPanicAsAFailure(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)
	withBody(t, func(context.Context, string, Deps) error { panic("job exploded") })

	_, err := Run(context.Background(), "frequent", "cli", d)
	if err == nil || !strings.Contains(err.Error(), "panic: job exploded") {
		t.Fatalf("Run err = %v, want the panic as an error", err)
	}
	runs := runsOf(t, a.Deps.Pool, "frequent")
	if len(runs) != 1 || runs[0].ok == nil || *runs[0].ok || runs[0].errText == nil ||
		!strings.Contains(*runs[0].errText, "panic: job exploded") {
		t.Fatalf("runs = %+v, want one failed run naming the panic", runs)
	}
}

func TestRunTruncatesALongError(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)
	withBody(t, func(context.Context, string, Deps) error {
		return errors.New(strings.Repeat("x", 600))
	})

	_, _ = Run(context.Background(), "frequent", "cli", d)
	runs := runsOf(t, a.Deps.Pool, "frequent")
	if len(runs) != 1 || runs[0].errText == nil || len(*runs[0].errText) != maxRunError {
		t.Fatalf("stored error length = %v, want %d", runs, maxRunError)
	}
}

// Another process holding the job's lock is what an overlapping CronJob or
// a console run during the scheduler's tick looks like.
func TestRunRefusesWhileTheJobIsLocked(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)
	withBody(t, func(context.Context, string, Deps) error { return nil })
	ctx := context.Background()

	conn, err := a.Deps.Pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, lockKey("nightly")); err != nil {
		t.Fatalf("lock: %v", err)
	}

	if _, err := Run(ctx, "nightly", "schedule", d); !errors.Is(err, ErrJobRunning) {
		t.Fatalf("Run while locked = %v, want ErrJobRunning", err)
	}
	if runs := runsOf(t, a.Deps.Pool, "nightly"); len(runs) != 0 {
		t.Errorf("a refused run left rows: %+v", runs)
	}
	// Each job has its own lock.
	if _, err := Run(ctx, "frequent", "schedule", d); err != nil {
		t.Errorf("frequent while nightly is locked: %v", err)
	}

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, lockKey("nightly")); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	conn.Release()

	// Free again, and released again after a run: two in a row both go.
	for i := range 2 {
		if _, err := Run(ctx, "nightly", "schedule", d); err != nil {
			t.Fatalf("Run %d after unlock: %v", i, err)
		}
	}
}

// The console's shape: Start returns once the run is recorded, while the
// job is still going, and the lock holds until it ends.
func TestStartReturnsWhileTheJobRuns(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)
	release := make(chan struct{})
	withBody(t, func(context.Context, string, Deps) error {
		<-release
		return nil
	})
	ctx := context.Background()

	id, wait, err := Start(ctx, "frequent", "console", d)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	runs := runsOf(t, a.Deps.Pool, "frequent")
	if len(runs) != 1 || runs[0].id != id || runs[0].finished || runs[0].trigger != "console" {
		t.Fatalf("runs while running = %+v, want one unfinished console run", runs)
	}
	if _, _, err := Start(ctx, "frequent", "console", d); !errors.Is(err, ErrJobRunning) {
		t.Errorf("second Start = %v, want ErrJobRunning", err)
	}

	close(release)
	if err := wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	runs = runsOf(t, a.Deps.Pool, "frequent")
	if len(runs) != 1 || !runs[0].finished || runs[0].ok == nil || !*runs[0].ok {
		t.Fatalf("runs after = %+v, want the one run finished ok", runs)
	}
}

func TestRunRejectsAnUnknownJob(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)
	if _, err := Run(context.Background(), "weekly", "cli", d); err == nil {
		t.Fatal("Run(weekly) = nil, want an error")
	}
}

// The frequent job alone writes 96 rows a day; nightly keeps 30 days.
func TestNightlyPrunesOldJobRuns(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 1, 3, 15, 0, 0, time.UTC)
	a.SetNow(now)
	d, _ := depsFor(a)
	ctx := context.Background()

	for _, age := range []time.Duration{40 * 24 * time.Hour, 10 * 24 * time.Hour} {
		started := now.Add(-age)
		if _, err := a.Deps.Pool.Exec(ctx, `
			INSERT INTO "job_run" ("job", "trigger", "started_at", "finished_at", "ok")
			VALUES ('frequent', 'schedule', $1, $1, true)`, started); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	if _, err := Run(ctx, "nightly", "schedule", d); err != nil {
		t.Fatalf("Run(nightly): %v", err)
	}
	var old, kept int
	if err := a.Deps.Pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE "started_at" < $1), count(*) FILTER (WHERE "started_at" >= $1)
		FROM "job_run" WHERE "job" = 'frequent'`, now.Add(-30*24*time.Hour)).Scan(&old, &kept); err != nil {
		t.Fatalf("count: %v", err)
	}
	if old != 0 || kept != 1 {
		t.Errorf("after nightly: %d runs older than 30 days, %d newer; want 0 and 1", old, kept)
	}
}
