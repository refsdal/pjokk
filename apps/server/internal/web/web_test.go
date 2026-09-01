package web_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/refsdal/pjokk/server/internal/web"
)

// wantHeaders is REF §A9's exact header set, CSP included byte-for-byte.
var wantHeaders = map[string]string{
	"X-Content-Type-Options":    "nosniff",
	"X-Frame-Options":           "DENY",
	"Referrer-Policy":           "same-origin",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"Permissions-Policy":        "camera=(), microphone=(), geolocation=()",
	"X-Robots-Tag":              "noindex, nofollow",
	"Content-Security-Policy":   "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
}

func assertA9Headers(t *testing.T, h http.Header) {
	t.Helper()
	for name, want := range wantHeaders {
		if got := h.Get(name); got != want {
			t.Errorf("header %s = %q, want %q", name, got, want)
		}
	}
}

func stubAPIHandler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("api handler was called for non-/api path %s", r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	})
}

func TestHandlerServesIndexAtRootWithA9Headers(t *testing.T) {
	handler := web.Handler(stubAPIHandler(t))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", rec.Code)
	}
	assertA9Headers(t, rec.Header())
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html prefix", ct)
	}
	if !strings.Contains(rec.Body.String(), "<html") {
		t.Errorf("body does not look like index.html: %q", rec.Body.String())
	}
}

func TestHandlerRobotsTxtDisallowsEverything(t *testing.T) {
	handler := web.Handler(stubAPIHandler(t))

	req := httptest.NewRequest(http.MethodGet, "/robots.txt", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /robots.txt status = %d, want 200", rec.Code)
	}
	assertA9Headers(t, rec.Header())
	want := "User-agent: *\nDisallow: /\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("robots.txt body = %q, want %q", got, want)
	}
}

func TestHandlerUnknownPathFallsBackToIndex(t *testing.T) {
	handler := web.Handler(stubAPIHandler(t))

	req := httptest.NewRequest(http.MethodGet, "/some/deep/spa/route", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /some/deep/spa/route status = %d, want 200", rec.Code)
	}
	assertA9Headers(t, rec.Header())
	if !strings.Contains(rec.Body.String(), "<html") {
		t.Errorf("body does not look like index.html: %q", rec.Body.String())
	}
}

func TestHandlerDelegatesAPIPathsUntouched(t *testing.T) {
	called := false
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := web.Handler(api)

	req := httptest.NewRequest(http.MethodGet, "/api/healthz-stub", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("api handler was not invoked for /api/* path")
	}
	// No REF §A9 headers on API responses (REF §A1: "No CSP on API").
	if rec.Header().Get("Content-Security-Policy") != "" {
		t.Errorf("CSP header set on /api/* response, want none")
	}
}

func TestScalarHTMLReferencesOpenAPIJSON(t *testing.T) {
	body := string(web.ScalarHTML())
	if !strings.Contains(body, "/api/openapi.json") {
		t.Errorf("scalar.html does not reference /api/openapi.json: %q", body)
	}
}
