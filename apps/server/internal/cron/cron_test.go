// The tests live in `package cron` rather than `package cron_test` (the
// convention everywhere else in this module) for one reason: runSafely, the
// recover-and-log wrapper that keeps a panicking job from killing the
// process, is unexported and has no observable effect through the exported
// surface — StartScheduler would only exercise it on a real cron tick.
// Testing it directly is the only way to prove the guarantee REF §A4 states.
package cron

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	robfig "github.com/robfig/cron/v3"

	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// recordingRateLimit wraps a real Store and counts Sweep calls, so a test
// can tell which dispatch branch RunJob took without having to seed expired
// counters and read the row count back.
type recordingRateLimit struct {
	inner  ratelimit.Store
	sweeps int
}

var _ ratelimit.Store = (*recordingRateLimit)(nil)

func (r *recordingRateLimit) Hit(ctx context.Context, key string, windowSeconds int) (int, error) {
	return r.inner.Hit(ctx, key, windowSeconds)
}

func (r *recordingRateLimit) Sweep(ctx context.Context, now time.Time) (int, error) {
	r.sweeps++
	return r.inner.Sweep(ctx, now)
}

// depsFor builds cron.Deps the same way cmd/pjokk's composition root does,
// minus the two swaps a test wants: in-memory storage and a recording push
// sender (both already wired by testrig.App).
func depsFor(a *testrig.AppRig) (Deps, *recordingRateLimit) {
	rl := &recordingRateLimit{inner: a.Deps.RateLimit}
	return Deps{
		Deps: jobs.Deps{
			Pool:    a.Deps.Pool,
			Q:       a.Deps.Q,
			Storage: a.Deps.Storage,
			Push:    a.Push,
			Now:     a.Deps.Now,
		},
		RateLimit: rl,
	}, rl
}

func TestJobsListsBothSchedules(t *testing.T) {
	if len(Jobs) != 2 || Jobs[0] != "nightly" || Jobs[1] != "frequent" {
		t.Fatalf("Jobs = %v, want [nightly frequent]", Jobs)
	}
	for _, job := range Jobs {
		if _, ok := Schedules[job]; !ok {
			t.Errorf("Schedules has no entry for %q", job)
		}
	}
	if len(Schedules) != len(Jobs) {
		t.Errorf("Schedules has %d entries, want %d", len(Schedules), len(Jobs))
	}
}

// The two cron expressions are a contract, not a preference: the nightly
// backup's 30-day retention window is stated in UTC in the privacy policy,
// so this asserts the parsed schedules against real UTC instants rather than
// comparing the strings to themselves.
func TestSchedulesFireAtTheDocumentedUTCTimes(t *testing.T) {
	parser := robfig.NewParser(robfig.Minute | robfig.Hour | robfig.Dom | robfig.Month | robfig.Dow)

	nightly, err := parser.Parse(Schedules["nightly"])
	if err != nil {
		t.Fatalf("parse nightly schedule: %v", err)
	}
	got := nightly.Next(time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
	if want := time.Date(2026, 3, 1, 3, 15, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("nightly next = %s, want %s", got, want)
	}

	frequent, err := parser.Parse(Schedules["frequent"])
	if err != nil {
		t.Fatalf("parse frequent schedule: %v", err)
	}
	got = frequent.Next(time.Date(2026, 3, 1, 9, 1, 0, 0, time.UTC))
	if want := time.Date(2026, 3, 1, 9, 15, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("frequent next = %s, want %s", got, want)
	}
}

// nightly = backup → prune → purge orphans → rate-limit sweep. The backup
// object and the Sweep call are the two observable ends of that chain.
func TestRunJobNightlyBacksUpAndSweeps(t *testing.T) {
	a := testrig.App(t)
	now := time.Date(2026, 3, 1, 3, 15, 0, 0, time.UTC)
	a.SetNow(now)

	d, rl := depsFor(a)
	if err := RunJob(context.Background(), "nightly", d); err != nil {
		t.Fatalf("RunJob(nightly): %v", err)
	}

	objects, err := a.Deps.Storage.List(context.Background(), "backups/")
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	if len(objects) != 1 || objects[0].Key != "backups/2026-03-01.json" {
		t.Errorf("backup objects = %+v, want exactly backups/2026-03-01.json", objects)
	}
	if rl.sweeps != 1 {
		t.Errorf("rate-limit sweeps = %d, want 1", rl.sweeps)
	}
}

// frequent = feed reminders → calendar reminders, and nothing else. A due
// feed reminder proves the first half ran; an untouched rate limiter and an
// empty backup prefix prove the nightly branch did not.
func TestRunJobFrequentSendsDueReminders(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, map[string]any{
		"endpoint": "https://fcm.googleapis.com/sub/cron",
		"p256dh":   "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
		"auth":     "tBHItJI5svbpez7KI4CCXg",
	}); res.Status != http.StatusOK {
		t.Fatalf("subscribe status = %d, body %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 3}); res.Status != http.StatusOK {
		t.Fatalf("set prefs status = %d, body %s", res.Status, res.Raw)
	}

	now := time.Now().Truncate(time.Second)
	if res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     now.Add(-4 * time.Hour).Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 100,
	}); res.Status != http.StatusCreated {
		t.Fatalf("create feed status = %d, body %s", res.Status, res.Raw)
	}

	// Pin the clock AFTER the fixtures are written: the reminder sweep reads
	// the same Deps.Now the API writes through, and a rewound clock would
	// make the 4-hour-old feed look like it is in the future.
	a.SetNow(now)

	d, rl := depsFor(a)
	if err := RunJob(context.Background(), "frequent", d); err != nil {
		t.Fatalf("RunJob(frequent): %v", err)
	}

	// Queried by email rather than LIMIT 1: db.EnsureTombstone seeds a
	// "deleted@pjokk.invalid" row with no ordering guarantee against it.
	var userID string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "users" WHERE "email" = $1`, "parent@example.com",
	).Scan(&userID); err != nil {
		t.Fatalf("read the rig's admin user id: %v", err)
	}
	if got := a.Push.Count(userID); got != 1 {
		t.Errorf("reminders delivered = %d, want 1", got)
	}
	if rl.sweeps != 0 {
		t.Errorf("rate-limit sweeps = %d, want 0 (that is the nightly job's work)", rl.sweeps)
	}
	objects, err := a.Deps.Storage.List(context.Background(), "backups/")
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	if len(objects) != 0 {
		t.Errorf("backup objects = %+v, want none", objects)
	}
}

// An unrecognised job name must be an error, never a silent no-op: it is
// what a typo'd Kubernetes CronJob argument looks like, and a CronJob that
// exits 0 having done nothing is the worst possible outcome.
func TestRunJobUnknownNameErrors(t *testing.T) {
	a := testrig.App(t)
	d, rl := depsFor(a)

	err := RunJob(context.Background(), "nightlyy", d)
	if err == nil {
		t.Fatal("RunJob(nightlyy) = nil, want an error")
	}
	if !strings.Contains(err.Error(), "nightlyy") {
		t.Errorf("error %q does not name the bad job", err)
	}
	if rl.sweeps != 0 {
		t.Errorf("rate-limit sweeps = %d, want 0", rl.sweeps)
	}
	objects, err := a.Deps.Storage.List(context.Background(), "backups/")
	if err != nil {
		t.Fatalf("list backups: %v", err)
	}
	if len(objects) != 0 {
		t.Errorf("backup objects = %+v, want none", objects)
	}
}

func TestIsJob(t *testing.T) {
	for _, name := range Jobs {
		if !IsJob(name) {
			t.Errorf("IsJob(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"", "Nightly", "backup", "frequent "} {
		if IsJob(name) {
			t.Errorf("IsJob(%q) = true, want false", name)
		}
	}
}

// REF §A4: "Each job wrapped in recover/log — a panicking job must not kill
// the process." runSafely is that wrapper; a panic escaping it would take
// down a container that is otherwise healthy.
func TestRunSafelySwallowsPanics(t *testing.T) {
	runSafely(context.Background(), "boom", func(context.Context) error {
		panic("job exploded")
	})
	runSafely(context.Background(), "sad", func(context.Context) error {
		return errors.New("job failed")
	})
	// Reaching here at all is the assertion: neither call unwound the stack.
}

// StartScheduler must hand back a stop function that actually stops, and it
// must be safe to call even though no tick has fired.
func TestStartSchedulerStops(t *testing.T) {
	a := testrig.App(t)
	d, _ := depsFor(a)

	stop := StartScheduler(d)
	if stop == nil {
		t.Fatal("StartScheduler returned a nil stop func")
	}
	stop()
}
