// Package cron owns Pjokk's scheduled work: which jobs exist, what each one
// runs, when they fire, and the in-process scheduler that fires them. It is
// the Go port of apps/server/src/cron.ts (the scheduler) and
// apps/server/src/cron-cli.ts's job dispatch half — the exit-code wrapper
// that CLI adds lives in cmd/pjokk, which owns every process exit.
//
// See docs/superpowers/plans/2026-08-31-go-migration-reference.md §A4 for
// the authoritative schedules and per-job composition this file implements.
//
// Two jobs, matching the two cron expressions the Cloudflare deployment used
// to carry in wrangler.jsonc:
//
//	nightly  — 15 3 * * *    backup → prune → purge orphans → sweep counters
//	frequent — */15 * * * *  feed reminders → calendar reminders
//
// Cloudflare guaranteed exactly one invocation per schedule no matter how
// many isolates were warm. NOTHING guarantees that here: with several
// replicas, an in-process timer in every pod would send each reminder once
// per pod. That is why RunJob is exposed as a one-shot a Kubernetes CronJob
// can invoke (`pjokk cron <job>`), and why StartScheduler runs only under
// the default single-container dispatch mode or the dedicated `worker`
// mode — never under `server`, which is what replicas run.
package cron

import (
	"context"
	"fmt"
	"log"
	"runtime/debug"
	"time"

	robfig "github.com/robfig/cron/v3"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
)

// Deps is everything the scheduled work needs.
//
// jobs.Deps is embedded rather than named because the four job functions
// take it directly; RateLimit sits alongside it because the nightly sweep of
// expired rate-limit counters is scheduled work but is not a *job* — nothing
// in internal/jobs rate-limits anything, and putting the store in jobs.Deps
// would make every job depend on a collaborator only one line of one job
// uses. KV expired those entries by itself; the Postgres table does not.
type Deps struct {
	jobs.Deps

	RateLimit ratelimit.Store
}

// Jobs is every dispatchable job name, in the order `pjokk cron` prints them
// in its usage line.
var Jobs = []string{"nightly", "frequent"}

// Schedules maps each job to its cron expression. Interpreted in UTC — see
// StartScheduler for why that is a contract rather than a default.
var Schedules = map[string]string{
	"nightly":  "15 3 * * *",
	"frequent": "*/15 * * * *",
}

// IsJob reports whether name is a dispatchable job. Exact match: "Nightly"
// and "frequent " are not jobs, and a CronJob argument that misses by a
// character should fail loudly rather than nearly work.
func IsJob(name string) bool {
	for _, job := range Jobs {
		if job == name {
			return true
		}
	}
	return false
}

// RunJob runs one job to completion and returns the first error it hit.
//
// The per-step logging mirrors cron.ts line for line: a CronJob's pod log is
// the only place anyone will look when asking "did last night's backup
// actually happen", so the counts are logged even though the caller only
// sees an error or nil. Zero-count steps stay silent — a nightly log that is
// three lines of "0" every night trains people to stop reading it.
func RunJob(ctx context.Context, name string, d Deps) error {
	switch name {
	case "nightly":
		return runNightly(ctx, d)
	case "frequent":
		return runFrequent(ctx, d)
	default:
		// Never a silent no-op: an unrecognised name is what a typo'd
		// CronJob argument looks like, and a CronJob that exits 0 having
		// done nothing is worse than one that fails.
		return fmt.Errorf("cron: unknown job %q (expected one of: %v)", name, Jobs)
	}
}

func runNightly(ctx context.Context, d Deps) error {
	now := d.Now()

	key, err := jobs.RunBackup(ctx, d.Deps, now)
	if err != nil {
		return err
	}
	log.Printf("cron: backup written to %s", key)

	pruned, err := jobs.PruneBackups(ctx, d.Deps, now)
	if err != nil {
		return err
	}
	if len(pruned) > 0 {
		log.Printf("cron: pruned %d expired backup(s)", len(pruned))
	}

	purged, err := jobs.PurgeOrphanUsers(ctx, d.Deps, now)
	if err != nil {
		return err
	}
	if purged > 0 {
		log.Printf("cron: purged %d orphan account(s)", purged)
	}

	// There is no plan reconciliation here. cron.ts ran reconcilePlans as a
	// compensating control for missed Stripe webhooks; billing does not
	// exist in this port (REF §A1), so there is nothing to reconcile.

	swept, err := d.RateLimit.Sweep(ctx, now)
	if err != nil {
		return err
	}
	if swept > 0 {
		log.Printf("cron: swept %d rate-limit counter(s)", swept)
	}
	return nil
}

func runFrequent(ctx context.Context, d Deps) error {
	now := d.Now()

	sent, err := jobs.RunFeedReminders(ctx, d.Deps, now)
	if err != nil {
		return err
	}
	if sent > 0 {
		log.Printf("cron: %d reminder(s) sent", sent)
	}

	calendarSent, err := jobs.RunCalendarReminders(ctx, d.Deps, now)
	if err != nil {
		return err
	}
	if calendarSent > 0 {
		log.Printf("cron: %d calendar reminder(s) sent", calendarSent)
	}
	return nil
}

// schedulerStopGrace bounds how long the stop function returned by
// StartScheduler waits for an in-flight job before giving up on it. A
// nightly backup that is mid-upload when SIGTERM arrives is worth a few
// seconds; one that is wedged on an unresponsive object store is not worth
// hanging the whole shutdown for, because the orchestrator's own grace
// period will SIGKILL us anyway and an unbounded wait just turns a clean
// exit into a killed one.
const schedulerStopGrace = 10 * time.Second

// StartScheduler starts the in-process scheduler and returns a function that
// stops it.
//
// The location is UTC EXPLICITLY. robfig/cron defaults to time.Local, and
// the image sets no TZ — so it would be UTC by accident rather than by
// contract, while the 30-day backup retention window is a privacy-policy
// commitment stated in UTC. "15 3 * * *" resolves to 03:15Z under UTC and
// 01:15Z under Europe/Oslo, which is a silently wrong backup time and a
// silently wrong retention boundary.
//
// Every invocation goes through runSafely: robfig/cron runs each job in its
// own goroutine, so a panic inside one would take down the entire process
// rather than just that run (a goroutine panic is not recoverable by the
// caller). Catching it here turns a transient database blip into a logged
// line instead of a pod restart loop, and the job is rescheduled normally.
//
// NOTE: this fires once per replica. With more than one replica, drive the
// jobs from Kubernetes CronJobs (or exactly one dedicated `worker` replica)
// rather than running `server` mode with this started too — see the package
// comment.
func StartScheduler(d Deps) func() {
	c := robfig.New(robfig.WithLocation(time.UTC))

	for _, job := range Jobs {
		job := job
		if _, err := c.AddFunc(Schedules[job], func() {
			// A fresh background context per tick: the scheduler outlives any
			// single request and a job must not be cancelled by one.
			runSafely(context.Background(), job, func(ctx context.Context) error {
				return RunJob(ctx, job, d)
			})
		}); err != nil {
			// Schedules is a compile-time constant map validated by
			// cron_test.go; a parse failure here means the source was edited
			// to something invalid, which should be loud at boot rather than
			// a job that silently never runs.
			panic(fmt.Sprintf("cron: invalid schedule for %q: %v", job, err))
		}
	}

	c.Start()

	return func() {
		stopped := c.Stop()
		select {
		case <-stopped.Done():
		case <-time.After(schedulerStopGrace):
			log.Printf("cron: stop grace elapsed with a job still running; leaving it behind")
		}
	}
}

// runSafely runs fn, logging (never propagating) both a returned error and a
// panic. REF §A4: "a panicking job must not kill the process".
func runSafely(ctx context.Context, name string, fn func(context.Context) error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("cron: %s panicked: %v\n%s", name, r, debug.Stack())
		}
	}()
	if err := fn(ctx); err != nil {
		log.Printf("cron: %s failed: %v", name, err)
	}
}
