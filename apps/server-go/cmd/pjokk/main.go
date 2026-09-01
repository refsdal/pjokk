// Command pjokk is the container's entrypoint and the application's
// composition root: the ONE place that reads the environment, opens the
// database pool, builds the auth service, picks a storage driver and a push
// sender, and hands the assembled collaborators to internal/api. Every
// package below this one receives its dependencies (CLAUDE.md's Deps rule);
// none of them reads os.Getenv or constructs a client at module scope.
//
// It is also the dispatch table. One image, several modes, selected by
// argv[1] — the Go port of apps/server/src/dispatch.ts. See
// docs/superpowers/plans/2026-08-31-go-migration-reference.md §A4 for the
// authoritative table; the short version:
//
//	(none)                 migrate under an advisory lock, then serve + schedule
//	server                 HTTP only — never migrates, never schedules
//	worker                 scheduler only, plus a bare /healthz
//	migrate | migrations   apply migrations, exit 0/1
//	cron <job>             run one job, exit 0/1 (bad job: usage, exit 2)
//	healthcheck            probe /healthz on this pod, exit 0/1
//	anything else          complain, exit 2
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	// The scratch/distroless image carries no /usr/share/zoneinfo, so
	// time.LoadLocation would fail there for every zone but UTC. The
	// calendar-reminder job formats event times in Europe/Oslo (REF §A7) and
	// the scheduler pins itself to UTC; both must resolve inside the
	// container, so the zone database is compiled into the binary.
	//
	// internal/jobs imports this too, for the same reason. Belt and braces
	// on purpose: a process-wide guarantee should not rest on which leaf
	// package a future refactor happens to leave in the import graph.
	_ "time/tzdata"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/config"
	"github.com/refsdal/pjokk/server/internal/cron"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/web"
)

// shutdownTimeout bounds how long a draining server waits for in-flight
// requests after SIGTERM. Kubernetes sends SIGTERM and then waits
// (terminationGracePeriodSeconds, 30s by default) before SIGKILL; draining
// inside that window is the difference between a rolling deploy that drops
// requests and one that does not. Deliberately under the default grace
// period, so we exit on our own terms rather than being killed mid-drain.
const shutdownTimeout = 20 * time.Second

// readHeaderTimeout caps how long a client may take to send its request
// headers — the slowloris brake. Only this one and IdleTimeout are set:
// ReadTimeout and WriteTimeout would also cap the BODY, and /api/files
// streams multi-megabyte uploads and downloads over phone connections, so a
// whole-request deadline here would show up as mysterious truncated uploads
// on a bad train. The overall request budget belongs to whatever proxy sits
// in front of this process.
const readHeaderTimeout = 15 * time.Second

// idleTimeout closes keep-alive connections that go quiet, so a long-lived
// proxy does not accumulate sockets against us indefinitely.
const idleTimeout = 120 * time.Second

func main() {
	os.Exit(run(os.Args[1:]))
}

// run is main's testable body: it returns the process's exit code instead of
// calling os.Exit, so nothing below this line has to know it is a program.
func run(args []string) int {
	d := parseArgs(args)

	switch d.mode {
	case modeHealthcheck:
		// Deliberately constructs NOTHING: no config, no pool, no auth. A
		// liveness probe must not fail because DATABASE_URL is wrong — that
		// is /readyz's job — and the distroless image has no shell for the
		// `bun -e "fetch(...)"` one-liner this replaces.
		return healthcheckMode(portFromEnv())

	case modeUnknown:
		// An unrecognised subcommand must NOT fall through to the server: a
		// typo'd `pjokk migrationz` in a Kubernetes Job would otherwise
		// silently become a pod that starts a web server and never
		// completes, instead of failing loudly.
		fmt.Fprintf(os.Stderr, "Unknown dispatch mode: %q. Expected one of: server, worker, migrate (or migrations), cron, healthcheck, or no argument to migrate-then-serve.\n", d.raw)
		return 2

	case modeMigrate:
		return migrateMode()

	case modeCron:
		return cronMode(d.job)

	case modeWorker:
		return workerMode()

	case modeServer:
		// HTTP only — no startup migration, no in-process scheduler. What
		// replicas run: migration is owned by the default mode's
		// advisory-locked step (or an explicit one-off `migrate`), and the
		// scheduler is owned by exactly one `worker` process (or Kubernetes
		// CronJobs), never by every HTTP replica at once.
		return serveMode(false, false)

	case modeDefault:
		// No subcommand: migrate under an advisory lock (safe even if
		// several containers boot at once — see db.ApplyMigrations), then
		// serve with the in-process scheduler. What a plain `docker run`
		// exercises for a single-container deployment.
		return serveMode(true, true)
	}

	return 2
}

// --- dispatch parsing -------------------------------------------------

type dispatchMode int

const (
	modeDefault dispatchMode = iota
	modeServer
	modeWorker
	modeMigrate
	modeCron
	modeHealthcheck
	modeUnknown
)

// dispatch is a parsed command line. raw is argv[1] exactly as typed, kept
// so the unknown-mode message can quote what the operator actually wrote;
// job is argv[2] for `cron`, empty otherwise.
type dispatch struct {
	mode dispatchMode
	raw  string
	job  string
}

// parseArgs interprets os.Args[1:]. It reads the environment not at all and
// touches nothing, which is what makes the whole dispatch table testable.
func parseArgs(args []string) dispatch {
	if len(args) == 0 || args[0] == "" {
		return dispatch{mode: modeDefault}
	}

	raw := args[0]
	switch raw {
	case "server":
		return dispatch{mode: modeServer, raw: raw}
	case "worker":
		return dispatch{mode: modeWorker, raw: raw}
	case "migrate", "migrations":
		// `migrations` is an alias kept from the Bun image's documented
		// `/app/dispatch migrations`; dropping it would break anyone's
		// existing Kubernetes Job manifest for no gain.
		return dispatch{mode: modeMigrate, raw: raw}
	case "healthcheck":
		return dispatch{mode: modeHealthcheck, raw: raw}
	case "cron":
		job := ""
		if len(args) > 1 {
			job = args[1]
		}
		return dispatch{mode: modeCron, raw: raw, job: job}
	default:
		return dispatch{mode: modeUnknown, raw: raw}
	}
}

// --- healthcheck ------------------------------------------------------

// portFromEnv reads PORT directly rather than through config.Load, on
// purpose: see modeHealthcheck's comment in run. config's own default is
// mirrored here.
func portFromEnv() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "3000"
}

// healthcheckMode probes this pod's own /healthz and returns the exit code
// Docker's HEALTHCHECK (and any exec-style liveness probe) should see: 0 for
// a 2xx, 1 for anything else, including a refused connection.
//
// The timeout is short and explicit: a probe with no deadline can hang for
// as long as the kernel's connect timeout allows, and a HEALTHCHECK that
// never returns reads as "still checking" rather than "unhealthy" — the
// wrong answer for a wedged process.
func healthcheckMode(port string) int {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return 0
	}
	return 1
}

// --- migrate ----------------------------------------------------------

func migrateMode() int {
	cfg, err := config.FromOS()
	if err != nil {
		log.Printf("configuration error: %v", err)
		return 1
	}

	// context.Background, not a signal-cancelled context: aborting DDL
	// halfway is strictly worse than being SIGKILLed after the grace period,
	// and goose has already committed whatever migrations completed.
	if err := db.ApplyMigrations(context.Background(), cfg.DatabaseURL); err != nil {
		log.Printf("migration failed: %v", err)
		return 1
	}
	log.Print("migrations applied")
	return 0
}

// --- cron -------------------------------------------------------------

// cronMode runs exactly one job and exits with a status a scheduler can act
// on: a failed backup should show up as a failed CronJob, not as a line in a
// log nobody reads.
func cronMode(job string) int {
	if !cron.IsJob(job) {
		fmt.Fprintf(os.Stderr, "usage: pjokk cron <%s>\n", strings.Join(cron.Jobs, "|"))
		return 2
	}

	cfg, err := config.FromOS()
	if err != nil {
		log.Printf("configuration error: %v", err)
		return 1
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	deps, closeDeps, err := buildDeps(ctx, cfg)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer closeDeps()

	if err := cron.RunJob(ctx, job, cronDeps(deps)); err != nil {
		log.Printf("cron: %s failed: %v", job, err)
		return 1
	}
	return 0
}

// --- serve ------------------------------------------------------------

// serveMode is both the default mode (migrate=true, scheduler=true) and
// `server` mode (both false). Nothing else distinguishes them: `server`
// truly never migrates and never schedules.
func serveMode(migrate, scheduler bool) int {
	cfg, err := config.FromOS()
	if err != nil {
		log.Printf("configuration error: %v", err)
		return 1
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	if migrate {
		// Guarded by a Postgres advisory lock, so several containers booting
		// at once serialise instead of racing to apply the same DDL. Run on
		// context.Background for the reason migrateMode documents: a signal
		// arriving mid-DDL should not abort it.
		if err := db.ApplyMigrations(context.Background(), cfg.DatabaseURL); err != nil {
			log.Printf("migration failed: %v", err)
			return 1
		}
	}

	// Startup is not cancelled by the shutdown signal either: a SIGTERM one
	// millisecond into boot should produce a process that came up and then
	// drained cleanly, not a half-built Deps and a confusing error.
	deps, closeDeps, err := buildDeps(context.Background(), cfg)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer closeDeps()

	srv := &http.Server{
		// ":port" rather than "0.0.0.0:port": it binds every interface,
		// IPv6 included, which is a superset of what a Docker healthcheck
		// (127.0.0.1) and an IPv6-only Kubernetes cluster each need. Bun's
		// default bound loopback only, which in Docker looks like a server
		// that started fine and refuses every connection.
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           web.Handler(api.NewHandler(deps)),
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}

	log.Printf("pjokk listening on http://0.0.0.0:%d", cfg.Port)
	logStartupConfig(cfg)

	var stopScheduler func()
	if scheduler {
		log.Print("  scheduler: in-process (single-container mode)")
		stopScheduler = cron.StartScheduler(cronDeps(deps))
	}

	return serveUntilSignal(ctx, srv, stopScheduler)
}

// --- worker -----------------------------------------------------------

// workerMode runs ONLY the scheduler, for a deployment that scales the HTTP
// tier (`server` mode) horizontally but still wants one long-running process
// owning the cron-shaped work instead of driving it from Kubernetes
// CronJobs. Exactly one `worker` replica should run at a time — the same
// constraint the old SCHEDULER=1 env flag carried, now expressed by which
// mode you run rather than by a variable that could be set on more than one
// pod.
//
// The bare /healthz on PORT is not optional: the image's HEALTHCHECK probes
// /healthz regardless of mode, so without it a `worker` container would
// report unhealthy and get restart-looped by an orchestrator despite doing
// its job perfectly.
func workerMode() int {
	cfg, err := config.FromOS()
	if err != nil {
		log.Printf("configuration error: %v", err)
		return 1
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	deps, closeDeps, err := buildDeps(context.Background(), cfg)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer closeDeps()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}

	log.Printf("pjokk worker: scheduler running, healthz on http://0.0.0.0:%d", cfg.Port)
	logStartupConfig(cfg)

	stopScheduler := cron.StartScheduler(cronDeps(deps))

	return serveUntilSignal(ctx, srv, stopScheduler)
}

// --- shared plumbing --------------------------------------------------

// logStartupConfig prints the handful of settings worth having in the boot
// log, mirroring apps/server/src/main.ts. The disabled list in particular
// means "push isn't working" is answered by scrolling up rather than by an
// afternoon of debugging.
func logStartupConfig(cfg *config.Config) {
	log.Printf("  app url:   %s", cfg.AppURL)
	log.Printf("  site url:  %s", cfg.SiteURL)
	if off := cfg.DisabledSubsystems(); len(off) > 0 {
		log.Printf("  disabled:  %s", strings.Join(off, ", "))
	}
}

// serveUntilSignal runs srv until it fails or ctx is cancelled by SIGTERM /
// SIGINT, then stops the scheduler (if any) and drains in-flight requests.
// The scheduler stops FIRST: draining while new job runs are still being
// scheduled would be a race against ourselves.
func serveUntilSignal(ctx context.Context, srv *http.Server, stopScheduler func()) int {
	errc := make(chan error, 1)
	go func() {
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		// The listener died on its own — a port already in use, most
		// likely. ErrServerClosed cannot reach here (nothing has called
		// Shutdown yet), so any error is fatal.
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server failed: %v", err)
			if stopScheduler != nil {
				stopScheduler()
			}
			return 1
		}
		return 0

	case <-ctx.Done():
		log.Print("shutdown signal received, draining")
		if stopScheduler != nil {
			stopScheduler()
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			// Requests still in flight when the deadline expired. Worth a
			// line, but not worth a non-zero exit: the process did what it
			// was asked and the orchestrator is about to replace it anyway.
			log.Printf("shutdown: %v", err)
		}
		return 0
	}
}

// --- composition ------------------------------------------------------

// buildDeps assembles every collaborator the API and the jobs need, and
// returns a function that releases them. This is the only place in the
// program where a client is constructed from configuration.
//
// One builder for every mode, including `cron` and `worker`, which never
// serve a request and therefore never use the auth service. Splitting it
// into "the bits jobs need" and "the bits routes need" would buy a few
// milliseconds of CronJob startup and cost a second construction path that
// can drift from this one — the failure mode being a job that behaves
// subtly differently from the same job run in-process. apps/server's
// createDeps made the same trade.
func buildDeps(ctx context.Context, cfg *config.Config) (api.Deps, func(), error) {
	pool, err := db.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return api.Deps{}, nil, err
	}
	closePool := func() { pool.Close() }

	// Belt-and-braces alongside the migration's own seed row: the tombstone
	// user is the FK target every "delete this account" path repoints to, so
	// a database missing it fails deletions at the worst possible moment.
	if err := db.EnsureTombstone(ctx, pool); err != nil {
		closePool()
		return api.Deps{}, nil, err
	}

	q := dbgen.New(pool)

	authService, err := auth.New(auth.Config{
		AppURL:             cfg.AppURL,
		Secret:             cfg.AuthSecret,
		GoogleClientID:     cfg.GoogleClientID,
		GoogleClientSecret: cfg.GoogleClientSecret,
		OpenSignup:         cfg.OpenSignup,
		Pool:               pool,
	})
	if err != nil {
		closePool()
		return api.Deps{}, nil, err
	}

	store, err := buildStorage(cfg)
	if err != nil {
		closePool()
		return api.Deps{}, nil, err
	}

	sender, err := buildPush(q, cfg)
	if err != nil {
		closePool()
		return api.Deps{}, nil, err
	}

	deps := api.Deps{
		Pool:             pool,
		Q:                q,
		Auth:             authService,
		Storage:          store,
		RateLimit:        ratelimit.NewPostgres(q),
		Push:             sender,
		Now:              time.Now,
		AppURL:           cfg.AppURL,
		VAPIDPublicKey:   cfg.VAPIDPublicKey,
		TrustedProxyHops: cfg.TrustedProxyHops,

		// ExtraRoutes stays nil, always. It is internal/testrig's seam for
		// proving the middleware chain end-to-end; a real composition that
		// set it would be mounting routes that exist in no OpenAPI spec.
		ExtraRoutes: nil,
	}
	return deps, closePool, nil
}

// buildStorage picks the object-storage driver. config.Load has already
// rejected anything but "s3" and "fs" and checked that the chosen driver's
// own variables are present, so the default branch here is unreachable in
// practice — it exists so adding a driver to config without adding it here
// fails loudly instead of nil-panicking on the first upload.
func buildStorage(cfg *config.Config) (storage.Storage, error) {
	switch cfg.StorageDriver {
	case "s3":
		return storage.NewS3(storage.S3Config{
			Bucket:          cfg.S3Bucket,
			Endpoint:        cfg.S3Endpoint,
			AccessKeyID:     cfg.S3AccessKeyID,
			SecretAccessKey: cfg.S3SecretAccessKey,
			Region:          cfg.S3Region,
		}), nil
	case "fs":
		// NewFS probes the root for writability and fails here rather than
		// on the first upload, so a misconfigured volume crash-loops the
		// container on boot where it is obvious.
		return storage.NewFS(cfg.StorageFSPath)
	default:
		return nil, fmt.Errorf("unsupported STORAGE_DRIVER %q", cfg.StorageDriver)
	}
}

// buildPush returns the real web-push sender when VAPID keys are configured
// and a no-op sender otherwise. A self-hosted instance need not set up web
// push at all, and should boot and serve rather than crash-loop over a
// feature it never uses — config.DisabledSubsystems already names it in the
// boot log so the omission is visible.
func buildPush(q *dbgen.Queries, cfg *config.Config) (push.Sender, error) {
	if cfg.VAPIDPublicKey == "" || cfg.VAPIDPrivateKey == "" {
		return push.NewNoop(), nil
	}
	return push.New(q, cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, cfg.AppURL)
}

// cronDeps narrows the API's Deps to what the scheduled work needs. Same
// objects, not a second construction: one pool, one storage client, one push
// sender per process.
func cronDeps(d api.Deps) cron.Deps {
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
