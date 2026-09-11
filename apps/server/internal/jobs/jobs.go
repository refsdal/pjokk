// Package jobs is the Go port of apps/api/src/jobs: the nightly backup
// (+ retention prune), the feed-reminder sweep, the calendar-reminder sweep,
// and the orphan-user purge.
//
// There is no reconcilePlans here — apps/api/src/jobs/plans.ts's other half,
// a compensating control for Stripe webhook failures. Billing does not
// exist in this port, so there is nothing to reconcile.
//
// Wiring these functions to the scheduler and the one-shot CLI is
// internal/cron's job, not this package's: jobs only exports the run
// functions and the Deps they need, mirroring apps/api/src/deps.ts's Deps
// rather than constructing its own collaborators.
package jobs

import (
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/storage"
)

// Deps is every collaborator a job needs — the same "assembled by the
// composition root, never constructed here" discipline api.Deps follows
// (CLAUDE.md's Deps rule, apps/api/src/deps.ts's TypeScript original).
//
// Pool is used directly (rather than only through Q) by the backup job,
// which runs a raw `SELECT * FROM "<table>"` per entry in a hard-coded Go
// table list — not something sqlc's static analysis can express, since the
// table name varies per call.
type Deps struct {
	Pool *pgxpool.Pool
	Q    *dbgen.Queries

	Storage storage.Storage
	Push    push.Sender

	// SnoozeKey signs the Snooze button on every reminder notification
	// (internal/push/snooze.go); cmd/pjokk derives it from AUTH_SECRET.
	SnoozeKey [32]byte

	// Now returns the job's clock. Every run function takes an explicit
	// `now time.Time` parameter defaulting to Now() (Go has no default
	// parameter values, so callers needing the override — tests, mostly —
	// pass it positionally; production callers pass Now()).
	Now func() time.Time
}
