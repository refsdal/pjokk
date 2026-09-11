// Package web serves the embedded SPA build and the security headers that
// go with it. It is the outermost layer of the HTTP server: NewHandler in
// package api builds the /api/* handler, and web.Handler wraps it — every
// request lands here first.
//
// The header set and CSP string are the TypeScript app's, byte-for-byte,
// with one deliberate addition (see csp below).
package web

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
)

// distFS embeds the built SPA. dist/index.html is a placeholder committed
// so the package builds before the real frontend exists; the Docker image
// build overwrites the whole directory with the real Vite output before
// `go build` runs there (CLAUDE.md: one Bun-built SPA, one Go binary).
//
//go:embed all:dist
var distFS embed.FS

// scalarHTML is the static Scalar CDN loader served at GET /api/docs
// (package api, session-gated). It lives here because it is part of the
// "web assets" the binary embeds, not because /api/docs is a web.go route —
// it isn't; see scalar.html's own header comment for why it may load an
// external script when nothing else in this package can.
//
//go:embed scalar.html
var scalarHTML []byte

// ScalarHTML returns the embedded Scalar docs page. Exported for package api
// to serve at GET /api/docs after its own session gate.
func ScalarHTML() []byte { return scalarHTML }

// csp is the TypeScript app's Content-Security-Policy value, reproduced
// byte-exact except for one deliberate addition: `blob:` in img-src. The on-device
// avatar crop (apps/frontend/src/lib/avatar-image.ts) decodes the picked
// file through an object URL before uploading it, and object URLs are
// created by the page itself — this does not open the door to loading a
// third party's images, only the page's own in-memory blobs.
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// robotsBody is served at GET /robots.txt. Unconditional, and deliberately
// so: this is the APP host, which is entirely behind auth and has nothing
// worth indexing on any environment. INDEXABLE exists and is honoured, but
// only by `landing` mode (internal/landing), which serves the public site —
// the app never reads it. Setting INDEXABLE=1 in a shared .env therefore
// opens up the apex and leaves the app host disallowed, which is correct.
const robotsBody = "User-agent: *\nDisallow: /\n"

// securityHeaders sets the full security header set on a non-/api response.
// Called before any body is written, on every branch below (assets, robots,
// SPA fallback alike) — the header set does not vary by which of those a
// request happens to hit.
func securityHeaders(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	h.Set("Content-Security-Policy", csp)
}

// probePaths are the two top-level health endpoints package api registers
// outside the /api/ namespace (`GET /healthz` and
// `GET /readyz`, exactly where the TypeScript app mounted them). They need an
// exact-match escape hatch here because this handler otherwise dispatches to
// the API by /api/ prefix alone — without it both probes fall through to the
// SPA fallback and answer `200 text/html`, giving a liveness probe that
// passes unconditionally and a readiness probe with no connection to the
// database whatsoever. It is a silent failure: `curl -o /dev/null -w
// '%{http_code}'` reports 200 either way, which is how it survived a
// status-code-only smoke test.
//
// A path set rather than a second implementation of the probes: package api
// stays the single source of truth for what they actually do.
var probePaths = map[string]bool{
	"/healthz": true,
	"/readyz":  true,
}

// Handler wraps apiHandler with static asset serving, the SPA fallback, and
// the security headers on everything that is not an API path.
//
// Requests under /api/, and the two top-level probes, are handed to
// apiHandler UNTOUCHED — no headers are added here, matching the TypeScript
// app (no CSP on API responses) and its mount order, where the probes were
// registered ahead of the header middleware and so never received them
// either. Package api owns whatever headers its own responses need.
func Handler(apiHandler http.Handler) http.Handler {
	assets, err := fs.Sub(distFS, "dist")
	if err != nil {
		// distFS is compiled in; a broken subtree means the embed directive
		// itself is wrong, which build should have caught. Panicking here
		// beats serving 500s for every request with no explanation.
		panic(fmt.Sprintf("web: dist embed is broken: %v", err))
	}
	return handler(assets, apiHandler)
}

// handler is Handler over any asset tree. The embedded one is a placeholder
// holding only index.html until the image build overlays the real SPA, so
// tests pass a fixture shaped like `vite build` output instead.
func handler(assets fs.FS, apiHandler http.Handler) http.Handler {
	assetServer := http.FileServer(http.FS(assets))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" || probePaths[r.URL.Path] {
			apiHandler.ServeHTTP(w, r)
			return
		}

		securityHeaders(w.Header())

		if r.Method == http.MethodGet && r.URL.Path == "/robots.txt" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte(robotsBody))
			return
		}

		if servedAsFile(assets, assetServer, w, r) {
			return
		}

		// SPA fallback: any path that isn't a known asset serves index.html
		// at 200 — the client-side router (TanStack Router) decides what it
		// means, exactly like the old edge deployment's asset-not-found path.
		serveIndex(assets, w)
	})
}

// servedAsFile reports whether the request path names a real file in the
// embedded asset tree (never a directory — index.html is served through the
// explicit SPA-fallback path below, not by letting http.FileServer redirect
// "/" to it) and, if so, serves it.
func servedAsFile(assets fs.FS, assetServer http.Handler, w http.ResponseWriter, r *http.Request) bool {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		return false
	}
	info, err := fs.Stat(assets, name)
	if err != nil || info.IsDir() {
		return false
	}
	w.Header().Set("Cache-Control", cacheControl(name))
	assetServer.ServeHTTP(w, r)
	return true
}

// cacheControl is the Cache-Control header for a file in the asset tree.
// Vite names everything it emits under assets/ by content hash (and public/
// has no assets/ directory to put an unhashed file there), so a new build
// is a new URL and the old one can be cached forever. Everything else —
// index.html, sw.js, push-sw.js, theme-init.js, the manifest, the icons —
// keeps its name across deploys and must be revalidated, or a proxy that
// caches by file extension could serve the previous build's copy after a
// deploy. A chunk that no longer exists never gets here: it falls back to
// index.html, which is no-cache, so HTML is never pinned at an asset URL.
func cacheControl(name string) string {
	if strings.HasPrefix(name, "assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}

func serveIndex(assets fs.FS, w http.ResponseWriter) {
	data, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		// Only reachable if the embedded dist/ tree is missing index.html
		// entirely, which the placeholder committed alongside this file
		// prevents in every build.
		http.Error(w, "index.html missing from embedded build", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
