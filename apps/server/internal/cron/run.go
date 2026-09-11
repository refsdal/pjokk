package cron

// Recorded, locked runs (docs/superpowers/specs/2026-09-11-admin-ops-design.md
// §1). Every caller — the scheduler, `pjokk cron <job>`, the console — goes
// through Claim, so every run leaves a job_run row wherever it ran and no
// job ever overlaps itself, whichever processes a deployment runs.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"runtime/debug"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	robfig "github.com/robfig/cron/v3"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// ErrJobRunning is what Claim, Start and Run return when the job's lock is
// held — by another process, or by a run in this one that has not
// finished. It writes no job_run row: the run holding the lock has one.
var ErrJobRunning = errors.New("cron: job already running")

// JobTimeouts bounds one run of each job. The same numbers tell the Ops page
// when a row that still says "running" belongs to a process that died.
var JobTimeouts = map[string]time.Duration{
	"nightly":  time.Hour,
	"frequent": 10 * time.Minute,
}

// StaleAfter is how long after its last success a job counts as stale on
// the Ops page: a day plus slack for nightly, two missed ticks for frequent.
var StaleAfter = map[string]time.Duration{
	"nightly":  26 * time.Hour,
	"frequent": 30 * time.Minute,
}

// jobLockKeyBase is the first of the per-job advisory-lock keys, one per
// entry in Jobs. Kept well clear of db.MigrationLockKey (72450001).
const jobLockKeyBase int64 = 72450100

// maxRunError caps the error text a job_run row keeps.
const maxRunError = 500

// jobRunRetention is how long job_run rows live; the nightly job prunes
// anything older. The frequent job alone writes 96 a day.
const jobRunRetention = 30 * 24 * time.Hour

// jobBody is the work a run does. A variable only so the tests can make a
// job fail, panic or block.
var jobBody = RunJob

// LockKey is the advisory-lock key a job's runs hold — what pg_locks shows
// while it runs, and what a test holds to stand in for another process.
func LockKey(job string) int64 {
	for i, j := range Jobs {
		if j == job {
			return jobLockKeyBase + int64(i)
		}
	}
	return jobLockKeyBase - 1 // unreachable: Claim checks IsJob first
}

// NextDue is the next time job's schedule fires after now, in UTC.
func NextDue(job string, now time.Time) (time.Time, error) {
	schedule, err := robfig.ParseStandard(Schedules[job])
	if err != nil {
		return time.Time{}, fmt.Errorf("cron: schedule for %q: %w", job, err)
	}
	return schedule.Next(now.UTC()), nil
}

// Claimed is a run that holds its job's lock and has its row, and has not
// started yet. The console writes its audit row in that gap, naming the run,
// so no run starts without one.
type Claimed struct {
	ID string

	job    string
	d      Deps
	unlock func()
}

// Claim takes the job's lock and records the run. The lock is
// session-scoped, on a pooled connection held until the run ends, so a
// process that dies mid-run takes its lock with it; its row stays
// unfinished and the Ops page calls it interrupted once the timeout passes.
func Claim(ctx context.Context, job, trigger string, d Deps) (*Claimed, error) {
	if !IsJob(job) {
		return nil, fmt.Errorf("cron: unknown job %q (expected one of: %v)", job, Jobs)
	}

	conn, err := d.Pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("cron: %s: acquire a connection: %w", job, err)
	}
	key := LockKey(job)
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&locked); err != nil {
		conn.Release()
		return nil, fmt.Errorf("cron: %s: take the lock: %w", job, err)
	}
	if !locked {
		conn.Release()
		return nil, ErrJobRunning
	}
	// A fresh context: the run's may have expired, and a lock left held on
	// a pooled connection would outlive the run. If the unlock fails the
	// connection is closed, which ends its session and the lock with it.
	unlock := func() {
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, key); err != nil {
			log.Printf("cron: %s: release the lock: %v; dropping the connection", job, err)
			_ = conn.Conn().Close(context.Background())
		}
		conn.Release()
	}

	id, err := d.Q.InsertJobRun(ctx, dbgen.InsertJobRunParams{
		Job: job, Trigger: trigger, StartedAt: pgtype.Timestamptz{Time: d.Now(), Valid: true},
	})
	if err != nil {
		unlock()
		return nil, fmt.Errorf("cron: %s: record the run: %w", job, err)
	}
	return &Claimed{ID: id, job: job, d: d, unlock: unlock}, nil
}

// Begin runs the claimed job in the background and returns at once. wait
// blocks until the run has ended, its row is closed and the lock released,
// and returns the job's own error.
//
// ctx is the run's context: the scheduler and the CLI pass theirs, so
// SIGTERM still cancels a run, and the console passes one detached from its
// request. The job's timeout applies on top.
func (c *Claimed) Begin(ctx context.Context) (wait func() error) {
	done := make(chan error, 1)
	go func() {
		runCtx, cancel := context.WithTimeout(ctx, JobTimeouts[c.job])
		runErr := runRecovered(runCtx, c.job, c.d)
		cancel()
		finishRun(c.ID, c.job, runErr, c.d)
		// Unlocked before wait returns, so a Run straight after a Run finds
		// the job free.
		c.unlock()
		done <- runErr
	}()
	return func() error { return <-done }
}

// Abandon gives a claim back without running it: no run happened, so its
// row goes, and the lock is released.
func (c *Claimed) Abandon() {
	if err := c.d.Q.DeleteJobRun(context.Background(), c.ID); err != nil {
		log.Printf("cron: %s: remove abandoned run %s: %v", c.job, c.ID, err)
	}
	c.unlock()
}

// Start is Claim and then Begin.
func Start(ctx context.Context, job, trigger string, d Deps) (runID string, wait func() error, err error) {
	c, err := Claim(ctx, job, trigger, d)
	if err != nil {
		return "", nil, err
	}
	return c.ID, c.Begin(ctx), nil
}

// Run is a whole run, start to finish.
func Run(ctx context.Context, job, trigger string, d Deps) (string, error) {
	id, wait, err := Start(ctx, job, trigger, d)
	if err != nil {
		return "", err
	}
	return id, wait()
}

// runRecovered runs the job and turns a panic into its error: a panicking
// job is a failed run, not a dead process.
func runRecovered(ctx context.Context, job string, d Deps) (err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("cron: %s panicked: %v\n%s", job, r, debug.Stack())
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return jobBody(ctx, job, d)
}

// finishRun closes the run's row on a fresh context, so a job that failed
// because its own context expired still gets its row closed.
func finishRun(id, job string, runErr error, d Deps) {
	ok := runErr == nil
	var msg *string
	if runErr != nil {
		s := runErr.Error()
		if len(s) > maxRunError {
			s = strings.ToValidUTF8(s[:maxRunError], "")
		}
		msg = &s
	}
	if err := d.Q.FinishJobRun(context.Background(), dbgen.FinishJobRunParams{
		ID: id, FinishedAt: pgtype.Timestamptz{Time: d.Now(), Valid: true}, Ok: &ok, Error: msg,
	}); err != nil {
		log.Printf("cron: %s: close run %s: %v", job, id, err)
	}
}
