package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"syscall"
	"testing"
)

// The dispatch table is the container's whole contract with its
// orchestrator: `server` must never migrate, a typo must never boot a web
// server, and `cron` must never exit 0 having done nothing. parseArgs is
// where all of that is decided, and it reads nothing and touches nothing, so
// it can be checked exhaustively here — REF §A4's table, row by row.
func TestParseArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want dispatch
	}{
		{"no arguments migrates then serves", nil, dispatch{mode: modeDefault}},
		{"empty slice is the default mode", []string{}, dispatch{mode: modeDefault}},
		{"an empty argv[1] is the default mode", []string{""}, dispatch{mode: modeDefault}},

		{"server", []string{"server"}, dispatch{mode: modeServer, raw: "server"}},
		{"worker", []string{"worker"}, dispatch{mode: modeWorker, raw: "worker"}},
		{"migrate", []string{"migrate"}, dispatch{mode: modeMigrate, raw: "migrate"}},
		{"migrations is an alias for migrate", []string{"migrations"}, dispatch{mode: modeMigrate, raw: "migrations"}},
		{"healthcheck", []string{"healthcheck"}, dispatch{mode: modeHealthcheck, raw: "healthcheck"}},
		{"landing", []string{"landing"}, dispatch{mode: modeLanding, raw: "landing"}},

		{"cron with a job", []string{"cron", "nightly"}, dispatch{mode: modeCron, raw: "cron", job: "nightly"}},
		{"cron with the other job", []string{"cron", "frequent"}, dispatch{mode: modeCron, raw: "cron", job: "frequent"}},
		{"cron with no job at all", []string{"cron"}, dispatch{mode: modeCron, raw: "cron"}},
		{"cron with an unknown job stays cron", []string{"cron", "hourly"}, dispatch{mode: modeCron, raw: "cron", job: "hourly"}},

		{"a typo is not the server", []string{"migrationz"}, dispatch{mode: modeUnknown, raw: "migrationz"}},
		{"case matters", []string{"Server"}, dispatch{mode: modeUnknown, raw: "Server"}},
		{"trailing arguments do not rescue an unknown mode", []string{"serve", "please"}, dispatch{mode: modeUnknown, raw: "serve"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseArgs(tc.args); got != tc.want {
				t.Errorf("parseArgs(%q) = %+v, want %+v", tc.args, got, tc.want)
			}
		})
	}
}

// cronMode's argument guard is the difference between a failed CronJob and a
// silently-did-nothing one. It must reject before any dependency is built,
// which is exactly why this test can run with no database in sight: if
// cronMode ever started constructing deps first, this would hang or fail on
// a missing DATABASE_URL instead of returning 2.
func TestCronModeRejectsBadJobsBeforeTouchingAnything(t *testing.T) {
	for _, job := range []string{"", "hourly", "Nightly", "nightly "} {
		if got := cronMode(job); got != 2 {
			t.Errorf("cronMode(%q) = %d, want 2", job, got)
		}
	}
}

// healthcheckMode is what Docker's HEALTHCHECK runs (the distroless image
// has no shell). Its whole job is turning one HTTP response into an exit
// code, so that mapping is what is tested.
func TestHealthcheckMode(t *testing.T) {
	tests := []struct {
		name   string
		status int
		want   int
	}{
		{"200 is healthy", http.StatusOK, 0},
		{"503 is not", http.StatusServiceUnavailable, 1},
		{"500 is not", http.StatusInternalServerError, 1},
		{"404 is not", http.StatusNotFound, 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/healthz" {
					t.Errorf("probed %q, want /healthz", r.URL.Path)
				}
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()

			if got := healthcheckMode(portOf(t, srv.URL)); got != tc.want {
				t.Errorf("healthcheckMode = %d, want %d", got, tc.want)
			}
		})
	}
}

// A refused connection is the ordinary "the process is still booting" case,
// and must read as unhealthy rather than as an error the probe swallows.
func TestHealthcheckModeUnreachablePortIsUnhealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	port := portOf(t, srv.URL)
	srv.Close() // nothing is listening on `port` any more

	if got := healthcheckMode(port); got != 1 {
		t.Errorf("healthcheckMode on a closed port = %d, want 1", got)
	}
}

// The drain log line names the signal, so "was this a rollout or somebody's
// Ctrl-C?" is answered by the log. os.Signal.String() would answer
// "terminated" / "interrupt" instead, which is neither what apps/server
// logged nor what anyone greps for.
func TestSignalName(t *testing.T) {
	if got := signalName(syscall.SIGTERM); got != "SIGTERM" {
		t.Errorf("signalName(SIGTERM) = %q, want \"SIGTERM\"", got)
	}
	if got := signalName(syscall.SIGINT); got != "SIGINT" {
		t.Errorf("signalName(SIGINT) = %q, want \"SIGINT\"", got)
	}
	// Anything else falls back to the stdlib rendering rather than "unknown".
	if got := signalName(syscall.SIGHUP); got == "" {
		t.Error("signalName(SIGHUP) = \"\", want the stdlib description")
	}
}

func TestPortFromEnv(t *testing.T) {
	t.Setenv("PORT", "")
	if got := portFromEnv(); got != "3000" {
		t.Errorf("portFromEnv with PORT unset = %q, want \"3000\"", got)
	}
	t.Setenv("PORT", "8080")
	if got := portFromEnv(); got != "8080" {
		t.Errorf("portFromEnv = %q, want \"8080\"", got)
	}
}

func portOf(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse %q: %v", rawURL, err)
	}
	return u.Port()
}
