package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// An internal test (package web, not web_test) because the embedded dist/
// tree is a placeholder holding only index.html, so the real build's
// content-hashed assets/ files can only be exercised through handler with
// a fixture tree shaped like `vite build` output.
func viteDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":                {Data: []byte("<!doctype html><html></html>")},
		"assets/index-Bx7f2kQa.js":  {Data: []byte("console.log(1)")},
		"assets/index-C4dPq9Lm.css": {Data: []byte("body{}")},
		"sw.js":                     {Data: []byte("// service worker")},
		"push-sw.js":                {Data: []byte("// push")},
		"theme-init.js":             {Data: []byte("// theme")},
		"manifest.webmanifest":      {Data: []byte("{}")},
		"icon.svg":                  {Data: []byte("<svg/>")},
	}
}

func TestCacheControlByPath(t *testing.T) {
	h := handler(viteDist(), http.NotFoundHandler())

	cases := []struct {
		path string
		want string
	}{
		// Vite names everything under assets/ by content hash: a new build
		// is a new URL, so the old one can be cached forever.
		{"/assets/index-Bx7f2kQa.js", "public, max-age=31536000, immutable"},
		{"/assets/index-C4dPq9Lm.css", "public, max-age=31536000, immutable"},
		// Everything else keeps its name across deploys and must revalidate.
		{"/", "no-cache"},
		{"/home", "no-cache"},
		{"/sw.js", "no-cache"},
		{"/push-sw.js", "no-cache"},
		{"/theme-init.js", "no-cache"},
		{"/manifest.webmanifest", "no-cache"},
		{"/icon.svg", "no-cache"},
		// A chunk from a previous build falls back to index.html; it must
		// never be pinned as immutable at a URL that looks like an asset.
		{"/assets/index-OldBuild.js", "no-cache"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s status = %d, want 200", c.path, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != c.want {
			t.Errorf("GET %s Cache-Control = %q, want %q", c.path, got, c.want)
		}
	}
}

func TestCacheControlIsNotSetOnAPIResponses(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := handler(viteDist(), api)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/assets/x.js", nil))
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Errorf("Cache-Control on /api/* = %q, want none (package api owns its headers)", got)
	}
}
