package api

// The operator console's Ops tab (docs/superpowers/specs/2026-09-11-admin-ops-design.md):
// the deployment's health, the scheduled jobs' recorded runs with Run now,
// and the nightly snapshots in storage. The snapshot download is
// hand-routed in admin_backup_download.go.
//
// Metadata about the deployment only: versions, where storage points (never
// a credential), sizes, and run records. Nothing here reads a log table.

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/cron"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/jobs"
)

// StorageInfo says where files live, for the Ops page: for s3 the bucket,
// region and endpoint host, for fs the path. Never a credential — cmd/pjokk
// fills it from config, and the access keys are not among its fields.
type StorageInfo struct {
	Driver   string
	Bucket   string
	Region   string
	Endpoint string // host only
	Path     string
}

// opsRunsShown is how many of each job's runs the Ops page lists.
const opsRunsShown = 10

// cronDeps narrows Deps to what a job needs: the same objects cmd/pjokk's
// cronDeps hands the scheduler, so a console run is the scheduled run.
func (d Deps) cronDeps() cron.Deps {
	return cron.Deps{
		Deps: jobs.Deps{
			Pool:    d.Pool,
			Q:       d.Q,
			Storage: d.Storage,
			Push:    d.Push,
			Now:     d.Now,
		},
		RateLimit: d.RateLimit,
	}
}

func (d Deps) GetAdminOps(ctx context.Context, _ gen.GetAdminOpsRequestObject) (gen.GetAdminOpsResponseObject, error) {
	now := d.Now()

	// goose's own table, which sqlc cannot see (no migration creates it);
	// the same read internal/testrig uses to decide whether to migrate.
	var applied int64
	if err := d.Pool.QueryRow(ctx,
		`SELECT COALESCE(MAX("version_id"), 0) FROM "goose_db_version" WHERE "is_applied"`,
	).Scan(&applied); err != nil {
		return nil, fmt.Errorf("api: read the applied migration: %w", err)
	}
	latest, err := db.LatestMigrationVersion()
	if err != nil {
		return nil, err
	}

	var size int64
	var serverVersion string
	if err := d.Pool.QueryRow(ctx,
		`SELECT pg_database_size(current_database()), current_setting('server_version')`,
	).Scan(&size, &serverVersion); err != nil {
		return nil, fmt.Errorf("api: read the database size: %w", err)
	}

	jobsOut := make([]gen.AdminJob, 0, len(cron.Jobs))
	for _, job := range cron.Jobs {
		j, err := d.adminJob(ctx, job, now)
		if err != nil {
			return nil, err
		}
		jobsOut = append(jobsOut, j)
	}

	s := d.StorageInfo
	return gen.GetAdminOps200JSONResponse{
		Version:  d.Version,
		Schema:   gen.AdminSchemaVersion{Applied: applied, Latest: latest},
		Storage:  gen.AdminStorage{Driver: s.Driver, Bucket: orNil(s.Bucket), Region: orNil(s.Region), EndpointHost: orNil(s.Endpoint), Path: orNil(s.Path)},
		Database: gen.AdminDatabase{SizeBytes: size, ServerVersion: serverVersion},
		Jobs:     jobsOut,
	}, nil
}

func (d Deps) adminJob(ctx context.Context, job string, now time.Time) (gen.AdminJob, error) {
	rows, err := d.Q.ListJobRuns(ctx, dbgen.ListJobRunsParams{Job: job, Limit: opsRunsShown})
	if err != nil {
		return gen.AdminJob{}, err
	}
	runs := make([]gen.AdminJobRun, 0, len(rows))
	for _, r := range rows {
		runs = append(runs, serJobRun(r, now))
	}

	var lastSuccess *time.Time
	switch at, err := d.Q.LastJobSuccess(ctx, job); {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return gen.AdminJob{}, err
	case at.Valid:
		t := at.Time
		lastSuccess = &t
	}

	next, err := cron.NextDue(job, now)
	if err != nil {
		return gen.AdminJob{}, err
	}
	// Never run is stale on purpose: it is what a deployment with nothing
	// scheduling looks like.
	stale := lastSuccess == nil || now.Sub(*lastSuccess) > cron.StaleAfter[job]
	return gen.AdminJob{
		Name:          job,
		Schedule:      cron.Schedules[job],
		NextDue:       next,
		LastSuccessAt: lastSuccess,
		Stale:         stale,
		Running:       len(runs) > 0 && runs[0].Status == "running",
		Runs:          runs,
	}, nil
}

// serJobRun reads a run's status off its row: a row still unfinished past
// its job's timeout belongs to a process that died, since Begin's own
// timeout would have ended the run and closed the row by then.
func serJobRun(r dbgen.JobRun, now time.Time) gen.AdminJobRun {
	status := "running"
	switch {
	case r.Ok != nil && *r.Ok:
		status = "ok"
	case r.Ok != nil:
		status = "failed"
	case now.Sub(r.StartedAt.Time) > cron.JobTimeouts[r.Job]:
		status = "interrupted"
	}
	out := gen.AdminJobRun{
		Id:        r.ID,
		Trigger:   gen.AdminJobRunTrigger(r.Trigger),
		StartedAt: r.StartedAt.Time,
		Status:    gen.AdminJobRunStatus(status),
		Error:     r.Error,
	}
	if r.FinishedAt.Valid {
		t := r.FinishedAt.Time
		out.FinishedAt = &t
	}
	return out
}

// RunAdminJob runs a job now, exactly as its schedule would. The claim (the
// lock and the row) comes first so the 409 is honest and the audit row can
// name the run; the audit row comes before the job starts, and a failed
// audit write gives the claim back, so nothing runs without a trail entry.
func (d Deps) RunAdminJob(ctx context.Context, req gen.RunAdminJobRequestObject) (gen.RunAdminJobResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	job := string(req.Job)

	claim, err := cron.Claim(ctx, job, "console", d.cronDeps())
	if errors.Is(err, cron.ErrJobRunning) {
		return gen.RunAdminJob409JSONResponse{Error: "That job is already running", Code: "JOB_RUNNING"}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := audit(ctx, d.Q, admin, "job.run", job, claim.ID); err != nil {
		claim.Abandon()
		return nil, err
	}
	// Detached from the request, which ends long before a nightly does;
	// the job's own timeout still bounds it.
	claim.Begin(context.WithoutCancel(ctx))
	return gen.RunAdminJob202JSONResponse{RunId: claim.ID}, nil
}

func (d Deps) ListAdminBackups(ctx context.Context, _ gen.ListAdminBackupsRequestObject) (gen.ListAdminBackupsResponseObject, error) {
	objects, err := d.Storage.List(ctx, "backups/")
	if err != nil {
		return nil, err
	}
	snapshots := make([]gen.AdminBackup, 0, len(objects))
	for _, o := range objects {
		date, ok := jobs.SnapshotDate(o.Key)
		if !ok {
			continue
		}
		snapshots = append(snapshots, gen.AdminBackup{Date: date, SizeBytes: o.Size, UploadedAt: o.UploadedAt})
	}
	// YYYY-MM-DD sorts as a string.
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].Date > snapshots[j].Date })

	current, err := d.Storage.List(ctx, jobs.PhotoBackupCurrentPrefix)
	if err != nil {
		return nil, err
	}
	var currentBytes int64
	for _, o := range current {
		currentBytes += o.Size
	}
	deleted, err := d.Storage.List(ctx, jobs.PhotoBackupDeletedPrefix)
	if err != nil {
		return nil, err
	}

	return gen.ListAdminBackups200JSONResponse{
		Snapshots:     snapshots,
		RetentionDays: jobs.BackupRetentionDays,
		Photos:        gen.AdminPhotoBackups{Current: len(current), CurrentBytes: currentBytes, Deleted: len(deleted)},
	}, nil
}
