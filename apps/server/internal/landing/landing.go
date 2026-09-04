// Package landing serves the prerendered marketing site at pjokk.no.
//
// It is the `landing` dispatch mode's whole payload, and it deliberately
// constructs nothing else: no database pool, no auth, no API routes. That is
// the same shape as `healthcheck` (see cmd/pjokk/main.go) and the reason one
// image can serve both hosts — `pjokk` on app.pjokk.no, `pjokk landing` on
// the apex — instead of publishing a second artifact for six HTML files.
//
// The documents themselves are built by apps/landing (bun, prerendered to
// two languages) and embedded here. What is NOT baked in is the deployment's
// own configuration: apps/landing/build.ts run with TEMPLATE=1 emits opaque
// tokens where the app URL, the site URL and the call-to-action label would
// go, and this package substitutes them ONCE at startup. That keeps the
// property the app image already has — one artifact promoted between
// environments — rather than reintroducing a build per host, which is
// exactly what the landing split moved away from.
package landing

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strings"
)

// distFS embeds the built landing site. A placeholder index.html and
// cta-labels.json are committed so `go build` and `go test` work without a
// bun build having run; scripts/landing-embed-overlay.sh replaces the whole
// directory with the real output before the shipping binary is compiled.
//
//go:embed all:dist
var distFS embed.FS

// Config is the landing site's entire runtime surface.
type Config struct {
	// SiteURL is the public origin of the landing site itself — canonical
	// links, hreflang alternates and the sitemap are written from it.
	SiteURL string
	// AppURL is where the call to action points (the app is a different
	// host from the marketing site).
	AppURL string
	// OpenSignup picks "Get started" over "Sign in".
	OpenSignup bool
	// Indexable gates robots.txt, sitemap.xml and the X-Robots-Tag header.
	// Fail-safe: the zero value keeps the host out of every index.
	Indexable bool
}

// csp is deliberately stricter than the SPA's (internal/web): the landing
// site is one self-contained document per URL with zero JavaScript, so
// nothing needs to execute and `script-src 'none'` costs nothing to promise.
const csp = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"

// ctaLabels mirrors apps/landing/src/copy.ts, which stays the single source
// of truth for user-facing copy — the build writes this sidecar so the
// Norwegian strings never get duplicated into Go.
type ctaLabels map[string]struct {
	SignIn string `json:"signIn"`
	SignUp string `json:"signUp"`
}

// Handler serves the embedded landing site.
func Handler(cfg Config) (http.Handler, error) {
	return New(distFS, cfg)
}

// New serves a landing build from any FS rooted at a "dist" directory.
// Exported separately so the tests can supply their own tree and the Go
// suite never depends on a frontend build having run.
func New(assets fs.FS, cfg Config) (http.Handler, error) {
	root, err := fs.Sub(assets, "dist")
	if err != nil {
		return nil, fmt.Errorf("landing: dist subtree: %w", err)
	}

	replacer, err := newReplacer(root, cfg)
	if err != nil {
		return nil, err
	}

	docs, err := renderDocs(root, replacer)
	if err != nil {
		return nil, err
	}

	site := &site{
		cfg:     cfg,
		docs:    docs,
		files:   root,
		fileSrv: http.FileServer(http.FS(root)),
		robots:  robotsBody(cfg),
		sitemap: sitemapBody(cfg, docs),
	}
	return site, nil
}

func newReplacer(root fs.FS, cfg Config) (*strings.Replacer, error) {
	raw, err := fs.ReadFile(root, "cta-labels.json")
	if err != nil {
		// A build without the sidecar is a build without the tokens either;
		// failing loudly at startup beats serving "__PJOKK_CTA_LABEL_EN__"
		// as a button label.
		return nil, fmt.Errorf("landing: cta-labels.json: %w", err)
	}
	var labels ctaLabels
	if err := json.Unmarshal(raw, &labels); err != nil {
		return nil, fmt.Errorf("landing: cta-labels.json: %w", err)
	}

	pairs := []string{
		"__PJOKK_APP_URL__", strings.TrimSuffix(cfg.AppURL, "/"),
		"__PJOKK_SITE_URL__", strings.TrimSuffix(cfg.SiteURL, "/"),
	}
	for lang, l := range labels {
		label := l.SignIn
		if cfg.OpenSignup {
			label = l.SignUp
		}
		pairs = append(pairs, "__PJOKK_CTA_LABEL_"+strings.ToUpper(lang)+"__", label)
	}
	return strings.NewReplacer(pairs...), nil
}

// renderDocs substitutes every token once, at startup, and keys the result
// by the clean URL it is served at. No per-request templating and no HTML
// parsing: a handful of documents, one Replacer pass each.
func renderDocs(root fs.FS, replacer *strings.Replacer) (map[string]string, error) {
	docs := map[string]string{}
	err := fs.WalkDir(root, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || path.Base(name) != "index.html" {
			return nil
		}
		body, err := fs.ReadFile(root, name)
		if err != nil {
			return err
		}
		docs[urlPath(path.Dir(name))] = replacer.Replace(string(body))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("landing: reading documents: %w", err)
	}
	if len(docs) == 0 {
		return nil, fmt.Errorf("landing: embedded build has no index.html")
	}
	return docs, nil
}

// urlPath maps a document's directory to the URL it is served at, matching
// the paths apps/landing's own sitemap used: each language's root keeps its
// trailing slash, everything else has none.
func urlPath(dir string) string {
	switch dir {
	case ".":
		return "/"
	case "nb":
		return "/nb/"
	default:
		return "/" + dir
	}
}

type site struct {
	cfg     Config
	docs    map[string]string
	files   fs.FS
	fileSrv http.Handler
	robots  string
	sitemap string
}

func (s *site) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	h.Set("Content-Security-Policy", csp)
	if !s.cfg.Indexable {
		// The <meta name="robots"> this replaces used to be a build-time
		// choice; as a header it is a deploy-time one, which is the whole
		// point of templating the build.
		h.Set("X-Robots-Tag", "noindex, nofollow")
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	switch r.URL.Path {
	case "/healthz", "/readyz":
		// The image bakes in HEALTHCHECK ["/app/pjokk", "healthcheck"],
		// which probes /healthz in EVERY dispatch mode — so without these a
		// landing container reports itself unhealthy forever. Same body as
		// package api's probes, so one probe definition works against any
		// mode. Readiness is liveness here: nothing to be unready for, this
		// mode having no database and no dependency of any kind.
		//
		// noindex regardless of cfg.Indexable — a probe endpoint has no
		// business in a search index.
		h.Set("X-Robots-Tag", "noindex, nofollow")
		h.Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"ok":true}`))
		return
	case "/robots.txt":
		h.Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(s.robots))
		return
	case "/sitemap.xml":
		if !s.cfg.Indexable {
			http.NotFound(w, r)
			return
		}
		h.Set("Content-Type", "application/xml; charset=utf-8")
		_, _ = w.Write([]byte(s.sitemap))
		return
	}

	if body, ok := s.docs[cleanPath(r.URL.Path)]; ok {
		// Prerendered marketing copy changes on deploy, and there is no
		// content hash in these URLs, so revalidate rather than cache.
		h.Set("Cache-Control", "no-cache")
		h.Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(body))
		return
	}

	if s.servedAsFile(w, r) {
		return
	}

	// No SPA fallback: this is a static site with no client-side router, so
	// an unknown path is simply not found.
	http.NotFound(w, r)
}

// cleanPath normalises a request path to the form renderDocs keyed on, so
// "/privacy" and "/privacy/" are the same document.
func cleanPath(p string) string {
	if p == "/" || p == "/nb/" {
		return p
	}
	if trimmed := strings.TrimSuffix(p, "/"); trimmed != "" {
		return trimmed
	}
	return p
}

func (s *site) servedAsFile(w http.ResponseWriter, r *http.Request) bool {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		return false
	}
	info, err := fs.Stat(s.files, name)
	if err != nil || info.IsDir() || path.Base(name) == "index.html" {
		return false
	}
	// og.png and icon*.png are not content-hashed, so a long immutable TTL
	// would pin a stale icon for as long as it lasted. An hour is enough to
	// spare the origin without outliving a deploy by much.
	w.Header().Set("Cache-Control", "public, max-age=3600")
	s.fileSrv.ServeHTTP(w, r)
	return true
}

func robotsBody(cfg Config) string {
	if !cfg.Indexable {
		return "User-agent: *\nDisallow: /\n"
	}
	return fmt.Sprintf("User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n",
		strings.TrimSuffix(cfg.SiteURL, "/"))
}

// sitemapBody reproduces the format apps/landing/build.ts emitted: every
// prerendered document in both languages, each carrying the same pair of
// hreflang alternates. Derived from the embedded tree rather than a hardcoded
// list, so a new document appears without anyone remembering to add it.
func sitemapBody(cfg Config, docs map[string]string) string {
	origin := strings.TrimSuffix(cfg.SiteURL, "/")

	paths := make([]string, 0, len(docs))
	for p := range docs {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">` + "\n")
	for _, p := range paths {
		en, nb := languagePair(p)
		fmt.Fprintf(&b, "  <url>\n    <loc>%s%s</loc>\n", origin, p)
		fmt.Fprintf(&b, "    <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"%s%s\"/>\n", origin, en)
		fmt.Fprintf(&b, "    <xhtml:link rel=\"alternate\" hreflang=\"nb\" href=\"%s%s\"/>\n", origin, nb)
		b.WriteString("  </url>\n")
	}
	b.WriteString("</urlset>\n")
	return b.String()
}

// languagePair returns the English and Norwegian URLs for one document,
// given either of them.
func languagePair(p string) (en, nb string) {
	if p == "/nb/" {
		return "/", "/nb/"
	}
	if rest, ok := strings.CutPrefix(p, "/nb/"); ok {
		return "/" + rest, p
	}
	if p == "/" {
		return "/", "/nb/"
	}
	return p, "/nb" + p
}
