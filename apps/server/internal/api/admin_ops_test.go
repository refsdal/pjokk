package api_test

// The Ops tab (docs/superpowers/specs/2026-09-11-admin-ops-design.md): the
// health read, Run now, and the backup list.

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/cron"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func opsJobs(t *testing.T, res *testrig.Result) map[string]map[string]any {
	t.Helper()
	if res.Status != http.StatusOK {
		t.Fatalf("ops = %d %s", res.Status, res.Raw)
	}
	out := map[string]map[string]any{}
	for _, j := range res.JSON["jobs"].([]any) {
		job := j.(map[string]any)
		out[job["name"].(string)] = job
	}
	return out
}

func seedRun(t *testing.T, a *testrig.AppRig, job string, started time.Time, finished bool, ok bool, errText string) {
	t.Helper()
	var finishedAt, okVal, errVal any
	if finished {
		finishedAt, okVal = started.Add(time.Minute), ok
		if errText != "" {
			errVal = errText
		}
	}
	if _, err := a.Rig.Pool.Exec(context.Background(), `
		INSERT INTO "job_run" ("job", "trigger", "started_at", "finished_at", "ok", "error")
		VALUES ($1, 'schedule', $2, $3, $4, $5)`, job, started, finishedAt, okVal, errVal); err != nil {
		t.Fatalf("seed run: %v", err)
	}
}

func sameInstant(t *testing.T, got any, want time.Time) bool {
	t.Helper()
	s, ok := got.(string)
	if !ok {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, s)
	return err == nil && parsed.Equal(want)
}

func TestAdminOpsReportsVersionSchemaStorageAndDatabase(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	res := a.Do(http.MethodGet, "/api/admin/ops", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("ops = %d %s", res.Status, res.Raw)
	}
	if res.JSON["version"] != testrig.Version {
		t.Errorf("version = %v, want %q", res.JSON["version"], testrig.Version)
	}
	schema := res.JSON["schema"].(map[string]any)
	if schema["applied"] != schema["latest"] || schema["latest"].(float64) < 15 {
		t.Errorf("schema = %v, want the rig migrated to the newest embedded version", schema)
	}
	storage := res.JSON["storage"].(map[string]any)
	if storage["driver"] != "memory" || len(storage) != 1 {
		t.Errorf("storage = %v, want just the rig's driver", storage)
	}
	database := res.JSON["database"].(map[string]any)
	if database["sizeBytes"].(float64) <= 0 || database["serverVersion"] == "" {
		t.Errorf("database = %v, want a size and a server version", database)
	}
}

// The storage description names where files live and nothing that opens it.
func TestAdminOpsNeverShowsAStorageCredential(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	a.Deps.StorageInfo.Driver = "s3"
	a.Deps.StorageInfo.Bucket = "pjokk-prod"
	a.Deps.StorageInfo.Region = "eu-north-1"
	a.Deps.StorageInfo.Endpoint = "s3.eu-north-1.amazonaws.com"
	a.Rebuild()

	res := a.Do(http.MethodGet, "/api/admin/ops", cookie, nil)
	storage := res.JSON["storage"].(map[string]any)
	if storage["bucket"] != "pjokk-prod" || storage["region"] != "eu-north-1" ||
		storage["endpointHost"] != "s3.eu-north-1.amazonaws.com" || storage["path"] != nil {
		t.Errorf("storage = %v", storage)
	}
	for _, word := range []string{"secret", "accessKey", "password", "token"} {
		if bytes.Contains(bytes.ToLower(res.Raw), []byte(strings.ToLower(word))) {
			t.Errorf("ops body mentions %q: %s", word, res.Raw)
		}
	}
}

func TestAdminOpsJobsStalenessAndStatus(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	now := time.Date(2026, 3, 1, 12, 5, 0, 0, time.UTC)
	a.SetNow(now)

	// Never run: both stale, nothing listed, the next due times from the
	// schedules.
	jobs := opsJobs(t, a.Do(http.MethodGet, "/api/admin/ops", cookie, nil))
	for name, due := range map[string]time.Time{
		"nightly":  time.Date(2026, 3, 2, 3, 15, 0, 0, time.UTC),
		"frequent": time.Date(2026, 3, 1, 12, 15, 0, 0, time.UTC),
	} {
		j := jobs[name]
		if j["stale"] != true || len(j["runs"].([]any)) != 0 || j["lastSuccessAt"] != nil || j["running"] != false {
			t.Errorf("%s never run = %v, want stale with no runs", name, j)
		}
		if !sameInstant(t, j["nextDue"], due) {
			t.Errorf("%s nextDue = %v, want %v", name, j["nextDue"], due)
		}
		if j["schedule"] != cron.Schedules[name] {
			t.Errorf("%s schedule = %v", name, j["schedule"])
		}
	}

	// Nightly succeeded ten hours ago: fresh. Frequent succeeded 40 minutes
	// ago and failed 20 minutes ago: stale, the failure on top.
	seedRun(t, a, "nightly", now.Add(-10*time.Hour), true, true, "")
	seedRun(t, a, "frequent", now.Add(-41*time.Minute), true, true, "")
	seedRun(t, a, "frequent", now.Add(-20*time.Minute), true, false, "push service down")

	jobs = opsJobs(t, a.Do(http.MethodGet, "/api/admin/ops", cookie, nil))
	nightly, frequent := jobs["nightly"], jobs["frequent"]
	if nightly["stale"] != false || !sameInstant(t, nightly["lastSuccessAt"], now.Add(-10*time.Hour+time.Minute)) {
		t.Errorf("nightly = %v, want fresh with its last success", nightly)
	}
	runs := frequent["runs"].([]any)
	if frequent["stale"] != true || len(runs) != 2 {
		t.Fatalf("frequent = %v, want stale with two runs", frequent)
	}
	newest, older := runs[0].(map[string]any), runs[1].(map[string]any)
	if newest["status"] != "failed" || newest["error"] != "push service down" || newest["trigger"] != "schedule" {
		t.Errorf("newest frequent run = %v, want the failure", newest)
	}
	if older["status"] != "ok" || older["error"] != nil {
		t.Errorf("older frequent run = %v, want ok", older)
	}

	// Unfinished: two hours is past nightly's hour — interrupted; five
	// minutes is not — running.
	seedRun(t, a, "nightly", now.Add(-2*time.Hour), false, false, "")
	jobs = opsJobs(t, a.Do(http.MethodGet, "/api/admin/ops", cookie, nil))
	if r := jobs["nightly"]["runs"].([]any)[0].(map[string]any); r["status"] != "interrupted" || r["finishedAt"] != nil {
		t.Errorf("a nightly run unfinished for 2 h = %v, want interrupted", r)
	}
	seedRun(t, a, "frequent", now.Add(-5*time.Minute), false, false, "")
	jobs = opsJobs(t, a.Do(http.MethodGet, "/api/admin/ops", cookie, nil))
	if r := jobs["frequent"]["runs"].([]any)[0].(map[string]any); r["status"] != "running" || jobs["frequent"]["running"] != true {
		t.Errorf("a frequent run 5 min in = %v, want running", jobs["frequent"])
	}
}

func TestAdminOpsListsOnlyTheLastTenRuns(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	now := time.Date(2026, 3, 1, 12, 5, 0, 0, time.UTC)
	a.SetNow(now)
	for i := range 12 {
		seedRun(t, a, "frequent", now.Add(-time.Duration(i+1)*15*time.Minute), true, true, "")
	}
	runs := opsJobs(t, a.Do(http.MethodGet, "/api/admin/ops", cookie, nil))["frequent"]["runs"].([]any)
	if len(runs) != 10 || !sameInstant(t, runs[0].(map[string]any)["startedAt"], now.Add(-15*time.Minute)) {
		t.Errorf("runs = %d, first %v; want the newest ten", len(runs), runs[0])
	}
}

// waitForRun polls until the run's row is closed, and reports how.
func waitForRun(t *testing.T, a *testrig.AppRig, id string) (ok bool, trigger string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var done *bool
		if err := a.Rig.Pool.QueryRow(context.Background(),
			`SELECT "ok", "trigger" FROM "job_run" WHERE "id" = $1`, id).Scan(&done, &trigger); err != nil {
			t.Fatalf("read run %s: %v", id, err)
		}
		if done != nil {
			return *done, trigger
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("run %s never finished", id)
	return false, ""
}

func TestRunAdminJobStartsARecordedAuditedRun(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Ops family")

	res := a.Do(http.MethodPost, "/api/admin/jobs/frequent/run", cookie, nil)
	if res.Status != http.StatusAccepted {
		t.Fatalf("run = %d %s, want 202", res.Status, res.Raw)
	}
	id, _ := res.JSON["runId"].(string)
	if ok, trigger := waitForRun(t, a, id); !ok || trigger != "console" {
		t.Errorf("run %s finished ok=%v trigger=%q, want ok from the console", id, ok, trigger)
	}

	var target, detail string
	if err := a.Rig.Pool.QueryRow(context.Background(), `
		SELECT "target", "detail" FROM "admin_audit" WHERE "admin_id" = $1 AND "action" = 'job.run'`,
		adminID).Scan(&target, &detail); err != nil {
		t.Fatalf("audit row: %v", err)
	}
	if target != "frequent" || detail != id {
		t.Errorf("audit = %q / %q, want frequent / the run id", target, detail)
	}
}

// Held by another process: the scheduler's tick, a CronJob, a second
// operator. Refused with no run recorded and nothing in the trail.
func TestRunAdminJobRefusesWhileTheJobRuns(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	ctx := context.Background()
	conn, err := a.Rig.Pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, cron.LockKey("nightly")); err != nil {
		t.Fatalf("lock: %v", err)
	}
	defer func() { _, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, cron.LockKey("nightly")) }()

	res := a.Do(http.MethodPost, "/api/admin/jobs/nightly/run", cookie, nil)
	if res.Status != http.StatusConflict || res.JSON["code"] != "JOB_RUNNING" {
		t.Fatalf("run while locked = %d %s, want 409 JOB_RUNNING", res.Status, res.Raw)
	}
	var runs, audits int
	if err := a.Rig.Pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM "job_run"), (SELECT count(*) FROM "admin_audit" WHERE "action" = 'job.run')`,
	).Scan(&runs, &audits); err != nil {
		t.Fatalf("count: %v", err)
	}
	if runs != 0 || audits != 0 {
		t.Errorf("a refused run left %d run rows and %d audit rows, want none", runs, audits)
	}
}

func TestRunAdminJobRejectsAnUnknownJob(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	if res := a.Do(http.MethodPost, "/api/admin/jobs/weekly/run", cookie, nil); res.Status != http.StatusBadRequest {
		t.Errorf("run weekly = %d %s, want 400", res.Status, res.Raw)
	}
}

func putObject(t *testing.T, a *testrig.AppRig, key string, size int) {
	t.Helper()
	body := bytes.Repeat([]byte("x"), size)
	if err := a.Deps.Storage.Put(context.Background(), key, bytes.NewReader(body), int64(size), "application/octet-stream"); err != nil {
		t.Fatalf("put %s: %v", key, err)
	}
}

func TestAdminBackupsListsSnapshotsNewestFirst(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops family")
	putObject(t, a, "backups/2026-08-30.json", 10)
	putObject(t, a, "backups/2026-08-31.json", 20)
	putObject(t, a, "backups/notes.txt", 3) // not a snapshot
	putObject(t, a, "photo-backups/current/a.jpg", 5)
	putObject(t, a, "photo-backups/current/b.jpg", 7)
	putObject(t, a, "photo-backups/deleted/2026-08-01/c.jpg", 9)

	res := a.Do(http.MethodGet, "/api/admin/backups", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("backups = %d %s", res.Status, res.Raw)
	}
	snaps := res.JSON["snapshots"].([]any)
	if len(snaps) != 2 {
		t.Fatalf("snapshots = %v, want the two snapshots only", snaps)
	}
	first, second := snaps[0].(map[string]any), snaps[1].(map[string]any)
	if first["date"] != "2026-08-31" || first["sizeBytes"] != float64(20) || second["date"] != "2026-08-30" || second["sizeBytes"] != float64(10) {
		t.Errorf("snapshots = %v, want 08-31 (20 B) then 08-30 (10 B)", snaps)
	}
	if res.JSON["retentionDays"] != float64(30) {
		t.Errorf("retentionDays = %v, want 30", res.JSON["retentionDays"])
	}
	photos := res.JSON["photos"].(map[string]any)
	if photos["current"] != float64(2) || photos["currentBytes"] != float64(12) || photos["deleted"] != float64(1) {
		t.Errorf("photos = %v, want 2 current (12 B) and 1 deleted", photos)
	}
}
