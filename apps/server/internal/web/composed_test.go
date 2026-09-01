// These tests exercise the FULL composed stack — web.Handler(api.NewHandler
// (deps)) — exactly as cmd/pjokk builds it, rather than either layer alone.
//
// That distinction is the whole point of the file. internal/api's own tests
// drive api.NewHandler directly, so they see /healthz and /readyz answer
// correctly; internal/web's tests drive web.Handler over a stub API handler,
// so they see delegation work for the paths the stub is asked about. Neither
// could catch the two probes falling through web.Handler's /api/ prefix check
// into the SPA fallback, where both answered `200 text/html` — a liveness
// probe passing unconditionally and a readiness probe with no connection to
// the database. A status-code-only smoke test reports 200 for that too, which
// is how it got as far as review.
//
// This is `package web_test` (an external test package), which is what makes
// importing internal/api legal here: internal/api imports internal/web, so a
// same-package test could not.
package web_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/testrig"
	"github.com/refsdal/pjokk/server/internal/web"
)

// composed builds the production handler stack over a real Postgres.
func composed(t *testing.T) (http.Handler, *testrig.AppRig) {
	t.Helper()
	a := testrig.App(t)
	return web.Handler(api.NewHandler(a.Deps)), a
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// assertJSONOK reports the decoded body of a JSON response, failing the test
// if the response was HTML — the exact symptom of a probe that fell through
// to the SPA fallback.
func assertJSON(t *testing.T, rec *httptest.ResponseRecorder, path string) map[string]any {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("GET %s Content-Type = %q, want application/json (body: %q)", path, ct, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("GET %s body is not JSON: %v (body: %q)", path, err, rec.Body.String())
	}
	return body
}

// GET /healthz through the composed stack must reach package api's liveness
// handler, not index.html.
func TestComposedHealthzReachesTheAPIHandler(t *testing.T) {
	h, _ := composed(t)

	rec := get(t, h, "/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /healthz = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	if body := assertJSON(t, rec, "/healthz"); body["ok"] != true {
		t.Errorf(`GET /healthz body = %v, want {"ok":true}`, body)
	}
}

// GET /readyz answers 200 while the pool is healthy and 503 once it is not.
// The 503 half is the assertion that matters: a readiness probe served from
// the SPA fallback would answer 200 with an HTML body forever, no matter what
// the database was doing.
func TestComposedReadyzTracksTheDatabase(t *testing.T) {
	h, a := composed(t)

	rec := get(t, h, "/readyz")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /readyz (healthy) = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	if body := assertJSON(t, rec, "/readyz"); body["ok"] != true {
		t.Errorf(`GET /readyz (healthy) body = %v, want {"ok":true}`, body)
	}

	// Closing the pool is the cheapest faithful stand-in for "Postgres is
	// unreachable": every subsequent query fails the same way a network
	// partition would. pgxpool.Close is guarded by a sync.Once, so the rig's
	// own t.Cleanup close is still safe after this.
	a.Rig.Pool.Close()

	rec = get(t, h, "/readyz")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz (pool closed) = %d, want 503 (body: %q)", rec.Code, rec.Body.String())
	}
	body := assertJSON(t, rec, "/readyz")
	if body["ok"] != false {
		t.Errorf(`GET /readyz (pool closed) body = %v, want {"ok":false,…}`, body)
	}
	if msg, _ := body["error"].(string); msg == "" {
		t.Errorf("GET /readyz (pool closed) body has no error message: %v", body)
	}
}

// The probes are an exact-match escape hatch, not a prefix: everything else
// still reaches the SPA, and an unknown /api/ path still gets JSON.
func TestComposedNonProbePathsAreUnaffected(t *testing.T) {
	h, _ := composed(t)

	for _, path := range []string{"/", "/home", "/healthz/extra", "/healthzz"} {
		rec := get(t, h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200 (SPA fallback)", path, rec.Code)
			continue
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET %s Content-Type = %q, want text/html (SPA fallback)", path, ct)
		}
		// The SPA fallback is a non-API response, so REF §A9's headers apply.
		assertA9Headers(t, rec.Header())
	}

	rec := get(t, h, "/api/definitely-not-a-route")
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /api/definitely-not-a-route = %d, want 404", rec.Code)
	}
	if body := assertJSON(t, rec, "/api/definitely-not-a-route"); body["code"] != "NOT_FOUND" {
		t.Errorf(`unmatched /api/ body = %v, want code "NOT_FOUND"`, body)
	}
}

// The probes must NOT pick up the SPA's security headers: package api owns
// its own response headers, and the TypeScript app mounted both probes ahead
// of its header middleware (REF §A1 mount order, items 3-5).
func TestComposedProbesDoNotGetSPAHeaders(t *testing.T) {
	h, _ := composed(t)

	for _, path := range []string{"/healthz", "/readyz"} {
		rec := get(t, h, path)
		if got := rec.Header().Get("Content-Security-Policy"); got != "" {
			t.Errorf("GET %s has CSP %q, want none", path, got)
		}
	}
}
