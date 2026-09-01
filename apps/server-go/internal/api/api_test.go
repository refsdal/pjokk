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
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

const testSecret = "pjokk-test-auth-secret-value-0123456789"
const signInPassword = "Testpass123"

// newDeps builds api.Deps against the shared test rig, with signup closed
// and no Google credentials (the shipped default).
func newDeps(t *testing.T) (api.Deps, *testrig.Rig) {
	t.Helper()
	rig := testrig.Setup(t)
	svc, err := auth.New(auth.Config{
		AppURL:     "http://localhost:3000",
		Secret:     testSecret,
		OpenSignup: false,
		Pool:       rig.Pool,
	})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	return api.Deps{Pool: rig.Pool, Q: rig.Q, Auth: svc}, rig
}

func TestHealthzDoesNotTouchTheDatabase(t *testing.T) {
	deps, rig := newDeps(t)
	// Prove Healthz never dereferences the pool: close it, then call
	// Healthz through a Deps still pointing at the closed pool.
	rig.Pool.Close()
	handler := api.NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /healthz status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["ok"] != true {
		t.Errorf("body = %v, want {ok:true}", body)
	}
}

func TestReadyzOkWithLivePool(t *testing.T) {
	deps, _ := newDeps(t)
	handler := api.NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /readyz status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["ok"] != true {
		t.Errorf("body = %v, want {ok:true}", body)
	}
}

func TestReadyzServiceUnavailableWithClosedPool(t *testing.T) {
	deps, _ := newDeps(t)

	// A second pool against the same database, closed before use, is the
	// standard way to force a pool-level failure without touching the
	// shared rig pool other tests in this file still need.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deadPool, err := db.New(ctx, testrig.DatabaseURL())
	if err != nil {
		t.Fatalf("open second pool: %v", err)
	}
	deadPool.Close()
	deps.Pool = deadPool

	handler := api.NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /readyz status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["ok"] != false {
		t.Errorf("body[ok] = %v, want false", body["ok"])
	}
	if _, ok := body["error"].(string); !ok || body["error"] == "" {
		t.Errorf("body[error] = %v, want a non-empty string", body["error"])
	}
}

func TestUnmatchedAPIPathReturns404Envelope(t *testing.T) {
	deps, _ := newDeps(t)
	handler := api.NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/nope status = %d, body %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["error"] != "Not found" || body["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", body)
	}
}

func TestDocsRequireSession(t *testing.T) {
	deps, _ := newDeps(t)
	handler := api.NewHandler(deps)

	for _, path := range []string{"/api/docs", "/api/openapi.json"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s (no session) status = %d, body %s", path, rec.Code, rec.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("GET %s: decode body: %v", path, err)
		}
		if body["code"] != "UNAUTHENTICATED" {
			t.Errorf("GET %s body = %v, want code UNAUTHENTICATED", path, body)
		}
	}
}

func TestDocsServeWithASession(t *testing.T) {
	deps, rig := newDeps(t)
	handler := api.NewHandler(deps)

	userID, err := deps.Auth.CreateUser(context.Background(), "Kari Nordmann", "kari@example.com", signInPassword)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	_ = userID
	_ = rig

	body, _ := json.Marshal(map[string]string{"credential": "kari@example.com", "password": signInPassword})
	signInReq := httptest.NewRequest(http.MethodPost, auth.BasePath+"/signin/credential", strings.NewReader(string(body)))
	signInReq.Header.Set("Content-Type", "application/json")
	signInRec := httptest.NewRecorder()
	handler.ServeHTTP(signInRec, signInReq)
	if signInRec.Code != http.StatusOK {
		t.Fatalf("sign in: got %d, body %s", signInRec.Code, signInRec.Body.String())
	}

	var cookie *http.Cookie
	for _, c := range signInRec.Result().Cookies() {
		if c.Name == "limen_session" && c.Value != "" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("no session cookie in sign-in response: %s", signInRec.Body.String())
	}

	docsReq := httptest.NewRequest(http.MethodGet, "/api/docs", nil)
	docsReq.AddCookie(cookie)
	docsRec := httptest.NewRecorder()
	handler.ServeHTTP(docsRec, docsReq)
	if docsRec.Code != http.StatusOK {
		t.Fatalf("GET /api/docs (signed in) status = %d, body %s", docsRec.Code, docsRec.Body.String())
	}
	if ct := docsRec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}

	specReq := httptest.NewRequest(http.MethodGet, "/api/openapi.json", nil)
	specReq.AddCookie(cookie)
	specRec := httptest.NewRecorder()
	handler.ServeHTTP(specRec, specReq)
	if specRec.Code != http.StatusOK {
		t.Fatalf("GET /api/openapi.json (signed in) status = %d, body %s", specRec.Code, specRec.Body.String())
	}
	var spec map[string]any
	if err := json.Unmarshal(specRec.Body.Bytes(), &spec); err != nil {
		t.Fatalf("decode /api/openapi.json body: %v", err)
	}
	if spec["openapi"] == nil {
		t.Errorf("spec body missing openapi field: %v", spec)
	}
}
