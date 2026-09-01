package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// TestInternalErrorsUseTheStandardEnvelope is a regression test for a code
// review finding on Task 9: gen.NewStrictHandler's DEFAULT
// ResponseErrorHandlerFunc is http.Error(w, err.Error(), 500) — a
// text/plain body carrying the raw Go error string. Since every
// gen.StrictServerInterface method (babies.go, me.go, and every future
// route) returns (nil, err) for an error condition it doesn't have a typed
// response for — almost always a database failure — that default would
// leak internals (e.g. a raw pgx error naming a query/table) straight to
// the client, with no {"error","code"} envelope at all. api.go's
// NewHandler now builds its strict handler via
// gen.NewStrictHandlerWithOptions with a ResponseErrorHandlerFunc
// (api.go's responseErrorHandler) that logs the real error server-side and
// answers with the standard 500 {"error":"Internal error","code":"INTERNAL"}
// envelope instead; this test proves that end to end against a real route.
//
// GET /api/me is the chosen entry point: closing Deps.Q's underlying pool
// makes ITS OWN database call (GetFamilyMembershipRole) fail without also
// breaking the middleware chain in front of it. Every OTHER route runs
// behind RequireFamily, which does its own Deps.Q lookup and would hit ITS
// own (already-enveloped, pre-existing) failure path first — never
// reaching the strict-server method at all, and so never exercising the
// fix under review. /api/me's tierSession chain (APIKeyAuth, Session,
// RequireSession) never touches Deps.Q when no pjk_ bearer is present, so
// the closed pool is guaranteed to fail inside the GetMe method itself.
func TestInternalErrorsUseTheStandardEnvelope(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "kari-broken@example.com")

	// A second pool against the same database, closed before use — the
	// same technique api_test.go's TestReadyzServiceUnavailableWithClosedPool
	// uses to force a real pgx failure without touching the rig's own
	// pool. A COPY of a.Deps with only Q swapped, so session/family
	// resolution (which goes through Deps.Auth, built against the live
	// pool) still succeeds and the failure is isolated to the strict
	// handler's own database call.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deadPool, err := db.New(ctx, testrig.DatabaseURL())
	if err != nil {
		t.Fatalf("open second pool: %v", err)
	}
	deadPool.Close()

	broken := a.Deps
	broken.Q = dbgen.New(deadPool)
	brokenHandler := api.NewHandler(broken)

	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set("Cookie", cookie)
	rec := httptest.NewRecorder()
	brokenHandler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %s, want 500", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json (oapi-codegen's default 500 is text/plain)", ct)
	}

	var envelope map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("body is not the JSON envelope: %v (body: %s)", err, rec.Body.String())
	}
	if envelope["code"] != "INTERNAL" {
		t.Errorf("code = %v, want INTERNAL", envelope["code"])
	}
	if envelope["error"] != "Internal error" {
		t.Errorf("error = %v, want %q", envelope["error"], "Internal error")
	}
	if len(envelope) != 2 {
		t.Errorf("envelope has fields beyond error/code (a leak?): %v", envelope)
	}

	// The whole point: no raw error internals in the body. A closed-pool
	// pgx error names the pool/connection state; none of that vocabulary
	// may appear in what the client receives.
	lower := strings.ToLower(rec.Body.String())
	for _, leak := range []string{"pool", "conn", "pgx", "sql"} {
		if strings.Contains(lower, leak) {
			t.Errorf("body leaks raw error internals (contains %q): %s", leak, rec.Body.String())
		}
	}
}
