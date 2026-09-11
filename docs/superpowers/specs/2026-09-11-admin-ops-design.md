# Admin console spec 3: ops — health, job runs, backups

Third of the four operator-console specs (`2026-09-08-admin-family-management-design.md`,
`2026-09-11-admin-user-support-design.md`; spec 4 is restore). It answers
the questions an operator of a running Pjokk asks before any other: is this
build on the schema it expects, did last night's backup happen, are
reminders going out, and where does the data actually live.

## Decisions (made in conversation, 2026-09-11)

- **The job runner runs the two jobs as scheduled** — `nightly` and
  `frequent`, exactly what `pjokk cron <job>` runs. No per-step buttons: the
  orphan purge deletes accounts and has no business behind a button of its
  own. A per-job lock keeps a manual run and a scheduled one from
  overlapping.
- **Backups: a list AND a download.** The operator was told the cost — the
  console would hand out every family's health data in one file, and the
  privacy policy needs a line about it — and chose the download. Section 3
  makes it as narrow as it can be.
- **Alerting is the console page only.** No push to operators, no public
  probe. The pod log already records failures, and a self-hoster has their
  own monitoring.
- **Run records and the lock live in Postgres** (approach A). In a split
  deployment the process answering `/admin` is not the one running the jobs
  — a `worker` replica or Kubernetes CronJobs are — so nothing held in
  memory could answer "did it run". Rejected: a queue the scheduler polls
  (a CronJob-only deployment has no poller, so a manual run would wait for
  the next tick or never happen), and no table at all (it cannot answer
  "did reminders run" or "did last night fail").

## 1. Job runs and the lock

**`job_run`** (migration `00015_job_run.sql`):

| column | |
|---|---|
| `id` | text, `gen_random_uuid()::text` |
| `job` | text — `nightly` or `frequent` |
| `trigger` | text — `schedule`, `cli` or `console` |
| `started_at` | timestamptz, default `now()` |
| `finished_at` | timestamptz, NULL while running |
| `ok` | boolean, NULL while running |
| `error` | text, NULL unless it failed; truncated to 500 characters |

Index on `(job, started_at DESC)`.

- **No user column.** Who pressed "Run now" is in `admin_audit`
  (`job.run`, target = the job, detail = the run id), written before the run
  starts. That keeps the table out of `ReassignUserReferences` and its guard
  test.
- **Not in the nightly backup.** It is bookkeeping, like goose's version
  table, so it joins `jobs.DeliberatelyExcluded`, with a comment saying why.
  The both-directions backup-tables test stays true.
- **Pruned nightly after 30 days**, as a step of the nightly job: the
  frequent job alone writes 96 rows a day.

**One entry point, `cron.Run(ctx, job, trigger, d) (runID string, err error)`,**
used by every caller — the in-process scheduler (`schedule`), `pjokk cron
<job>` (`cli`) and the console (`console`). `RunJob` stays the body it
wraps.

- It takes `pg_try_advisory_lock(key)` on a connection it acquires from the
  pool and holds for the whole run, then unlocks and releases it. Each job
  has its own key (`JobLockKeyBase + index`), distinct from
  `MIGRATION_LOCK_KEY`.
- **Lock free:** insert the row, run the job, close the row `ok` or with
  the error. A panic is recovered and recorded as a failure (`panic: …`).
  Closing the row uses a fresh background context, so a job that failed
  because its context expired still gets its row closed.
- **Lock held:** returns `ErrJobRunning` and writes no row. The scheduler
  and the CLI log "already running" and treat it as success — the job IS
  running, and a CronJob that overlaps a long nightly should not page
  anyone. The console answers `409 JOB_RUNNING`.
- **Console runs** split the same steps across the request: the handler
  takes the lock and inserts the row inside the request (so the 409 is
  honest and the id exists), writes the audit row, then hands the held
  connection to a goroutine that runs the job on a background context with
  its own timeout — **1 h** for nightly, **10 min** for frequent — and
  closes the row and the lock. The handler answers `202 {runId}`. This is
  `cron.Start(ctx, job, trigger, d) (runID string, wait func(), err error)`;
  `Run` is `Start` followed by `wait()`.
- **Interrupted runs.** A process killed mid-run leaves `finished_at` NULL.
  The lock is session-scoped, so it dies with the connection and the next
  run proceeds. Reads report a row that is still running after its job's
  timeout as `interrupted`.

The server process builds `cron.Deps` from `api.Deps` (Pool, Q, Storage,
Push, RateLimit, Now) — no second composition path.

## 2. The health page

A fifth console tab, **Ops** (`/admin/ops`), over **`GET /api/admin/ops`**
(tierSysadmin):

- **`version`** — `Deps.Version`, the same string as the image tag.
- **`schema`** — `{applied, latest}`: the highest applied goose version and
  `db.LatestMigrationVersion()`. The page flags `applied < latest` (a
  `server` replica whose rollout skipped `migrate`) and `applied > latest`
  (an old image on a newer database).
- **`storage`** — `{driver, bucket, region, endpointHost, path}`: for `s3`
  the bucket, region and the endpoint's host; for `fs` the path. Never a
  credential. Lets the operator check the EU-residency promise from the
  console. New `Deps` fields, filled from config in `cmd/pjokk`.
- **`database`** — `{sizeBytes, serverVersion}` from
  `pg_database_size(current_database())` and `SHOW server_version`.
- **`jobs[]`**, one per job in `cron.Jobs` order:
  - `name`, `schedule` (the cron expression, UTC), `nextDue` (the next
    time that expression fires after now)
  - `lastSuccessAt` (nullable)
  - `runs[]` — the last 10, newest first: `{id, trigger, startedAt,
    finishedAt, status, error}`, `status` one of `running`, `ok`, `failed`,
    `interrupted`
  - `stale` — true when `lastSuccessAt` is NULL or older than the job's
    threshold: **26 h** for nightly, **30 min** for frequent (two missed
    ticks). "Never run" is stale on purpose: it is what a deployment with
    nothing scheduling looks like.
  - `running` — whether the newest run is `running`.

**Overview** gains one status line above the tiles, from the same endpoint:
"All jobs healthy", or the first problem ("Nightly failed 3 h ago",
"Frequent is stale", "Schema is behind this build"), linking to Ops. The
backup list has its own endpoint, so Overview never lists storage.

While any job is running the Ops page refetches every 10 s; otherwise on
focus.

## 3. Backups

**`GET /api/admin/backups`** (tierSysadmin):

- `snapshots[]` — every `backups/YYYY-MM-DD.json`, newest first:
  `{date, sizeBytes, uploadedAt}`. At most ~31 rows, so no paging.
- `retentionDays` — 30 (`backupRetentionDays`, exported).
- `photos` — `{current, currentBytes, deleted}`: object counts (and the
  current copy's bytes) under `photo-backups/current/` and
  `photo-backups/deleted/`.

The storage port's `StoredObject` gains **`Size int64`**. All three drivers
already have it to hand (S3's listing, `fs.FileInfo`, the in-memory bytes).

**`GET /api/admin/backups/{date}`** — the download:

- **Hand-routed**, like `/api/export.csv` and `/api/files/{id}`: a streamed
  body does not fit the strict server. Wrapped in a new `sysadminChain`
  (session, then the system-admin check) so it gets exactly the tier the
  generated routes get; the tier gate test covers it.
- `date` must match `^\d{4}-\d{2}-\d{2}$` (400 `VALIDATION` otherwise);
  a missing snapshot is 404.
- **The audit row is written first** (`backup.download`, target = the
  date), checked; a failed audit write means no download.
- Headers: `Content-Type: application/json`, `Content-Disposition:
  attachment; filename="pjokk-backup-YYYY-MM-DD.json"`, `Cache-Control:
  no-store`.
- **Nothing else keeps a copy.** The service worker's NetworkFirst rule
  currently caches every `/api/` GET except auth and `/api/me` for 14 days,
  which would put the snapshot in Cache Storage. `/api/admin/` is excluded
  from runtime caching entirely — the console has no offline use, and its
  other responses (other people's emails and sessions) should not sit in an
  operator's browser either. For the same reason `admin` joins
  `NEVER_PERSIST`, so console queries stay out of the IndexedDB snapshot.
  The SPA downloads with `fetch` → blob → a temporary object URL, so the
  request is never a navigation the service worker could answer with the
  app shell.

**The privacy policy** (`apps/landing/src/legal/privacy.tsx`, both
languages) says backups "are only ever used to restore the service after a
failure". That stays true, and gains the download:

> Backups are only ever used to restore the service after a failure. For
> that purpose the operator can download a copy; every download is recorded
> in the audit trail, and a downloaded copy is kept inside the EU and
> deleted as soon as it has served its purpose.

> Sikkerhetskopier brukes utelukkende til å gjenopprette tjenesten etter
> feil. Til det formålet kan driftsansvarlig laste ned en kopi; hver
> nedlasting registreres i revisjonsloggen, og en nedlastet kopi oppbevares
> innenfor EU og slettes så snart den har gjort nytten sin.

The last clause is a promise the operator keeps, not one the code can: the
file lands wherever their browser saves it.

## 4. The screens

- `screens/admin/Ops.tsx`: Health (version, schema, storage, database),
  Jobs (one card per job: status, last success, next due, stale badge, a
  **Run now** button that turns into "Running…" and is disabled while the
  job runs; the last 10 runs below), Backups (snapshot rows — date, size,
  age — each with **Download**; the photo-backup line; "kept 30 days").
- Run now is a plain button, not tap-twice: both jobs are idempotent and
  the lock refuses overlap. A 409 says "Already running" as a toast and
  refetches.
- `lib/admin-ops.ts`: pure view logic — `opsSummary(ops)` (the Overview
  line) and `formatBytes(n)` — unit-tested.
- Strings through `t()` like the other console pages; the i18n check skips
  `screens/admin/`.
- Metadata only: the existing structural test keeps admin screens off log
  endpoints, and covers the new page.

## 5. API surface

| Route | Tier | Notes |
|---|---|---|
| `GET /api/admin/ops` | sysadmin | health + jobs |
| `POST /api/admin/jobs/{job}/run` | sysadmin | `job` ∈ {nightly, frequent} (enum, so anything else is a validation 400); audit `job.run`; `202 {runId}`; `409 JOB_RUNNING` |
| `GET /api/admin/backups` | sysadmin | list |
| `GET /api/admin/backups/{date}` | sysadmin | hand-routed download; audit `backup.download` |

## Testing

Test-first. Go against real Postgres (`go test -p 1 -count=1 ./...`):

- **`cron.Run`:** records an ok run with `finished_at`; a failing job
  records `ok=false` and the error; a panic is recorded as a failure and
  does not escape; the trigger is stored; with the lock held elsewhere it
  returns `ErrJobRunning` and writes no row; the lock is free again after a
  run. The nightly job prunes `job_run` rows older than 30 days and keeps
  newer ones.
- **Ops endpoint:** version and schema (`applied == latest` on the rig);
  storage fields for the rig's config and no credential anywhere in the
  body; database size > 0; stale logic with a fixed clock — never run,
  fresh, past the threshold, a failure after an older success;
  `interrupted` for a running row past its timeout; `nextDue` from the
  schedule.
- **Run endpoint:** 202 with a run id that finishes `ok`; audited; 409
  while the lock is held; unknown job 400.
- **Backups:** the list, newest first, with sizes and photo counts; the
  download's body, headers and audit row; 404 for a missing date; 400 for a
  malformed one.
- **Tiers:** every new route in `TestAdminRoutesRequireSysadmin`, the
  hand-routed download included.
- **Storage:** `Size` from the memory and fs drivers (and s3 wherever its
  driver test runs).
- **Guards:** the backup-tables test passes with `job_run` excluded.
- **Unit (bun):** `opsSummary` for each problem kind and the healthy case;
  `formatBytes`.
- **E2E:** an operator opens Ops, runs frequent and sees it finish ok;
  runs nightly, sees today's snapshot in the list and downloads it (a
  download event with the expected filename).

## Out of scope

Push or probe alerts (decided against); cancelling a running job;
per-step runs; restoring a snapshot (spec 4); a snapshot's contents in the
console.
