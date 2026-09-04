package landing_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/refsdal/pjokk/server/internal/landing"
)

// The landing site is prerendered by apps/landing (bun) and embedded here;
// these tests supply their own tiny tree instead, so the Go suite never
// depends on a frontend build having run. The shapes below mirror what
// `TEMPLATE=1 bun run build:landing` actually emits: HTML carrying opaque
// tokens, plus the cta-labels.json sidecar that keeps Norwegian copy in
// TypeScript rather than duplicating it into Go.

func testFS() fstest.MapFS {
	doc := func(lang string) string {
		return `<!doctype html><html lang="` + lang + `"><head>` +
			`<link rel="canonical" href="__PJOKK_SITE_URL__/"></head>` +
			`<body><a class="btn" href="__PJOKK_APP_URL__/login">` +
			`__PJOKK_CTA_LABEL_` + strings.ToUpper(lang) + `__</a></body></html>`
	}
	return fstest.MapFS{
		"dist/index.html":            {Data: []byte(doc("en"))},
		"dist/privacy/index.html":    {Data: []byte(doc("en"))},
		"dist/terms/index.html":      {Data: []byte(doc("en"))},
		"dist/nb/index.html":         {Data: []byte(doc("nb"))},
		"dist/nb/privacy/index.html": {Data: []byte(doc("nb"))},
		"dist/nb/terms/index.html":   {Data: []byte(doc("nb"))},
		"dist/og.png":                {Data: []byte("\x89PNG fake")},
		"dist/cta-labels.json": {Data: []byte(
			`{"en":{"signIn":"Sign in","signUp":"Get started"},` +
				`"nb":{"signIn":"Logg inn","signUp":"Kom i gang"}}`)},
	}
}

func newHandler(t *testing.T, cfg landing.Config) http.Handler {
	t.Helper()
	h, err := landing.New(testFS(), cfg)
	if err != nil {
		t.Fatalf("landing.New: %v", err)
	}
	return h
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func defaults() landing.Config {
	return landing.Config{
		SiteURL: "https://pjokk.no",
		AppURL:  "https://app.pjokk.no",
	}
}

func TestServesCleanURLs(t *testing.T) {
	h := newHandler(t, defaults())
	// A static site, so "/privacy" must resolve to privacy/index.html rather
	// than 404 or redirect — these are the URLs the sitemap and the SPA's
	// own legal links point at.
	for _, path := range []string{"/", "/privacy", "/terms", "/nb/", "/nb/privacy"} {
		rec := get(t, h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("GET %s content-type = %q, want text/html", path, ct)
		}
	}
}

func TestUnknownPathIs404(t *testing.T) {
	// Deliberately NOT the SPA's index.html fallback: this is a static site
	// with no client-side router, so a wrong URL is a wrong URL.
	if rec := get(t, newHandler(t, defaults()), "/nope"); rec.Code != http.StatusNotFound {
		t.Errorf("GET /nope = %d, want 404", rec.Code)
	}
}

func TestSubstitutesURLTokens(t *testing.T) {
	h := newHandler(t, landing.Config{
		SiteURL: "https://example.test",
		AppURL:  "https://app.example.test",
	})
	body := get(t, h, "/").Body.String()
	if strings.Contains(body, "__PJOKK_") {
		t.Errorf("unsubstituted token left in body: %s", body)
	}
	if !strings.Contains(body, `href="https://app.example.test/login"`) {
		t.Errorf("APP_URL not substituted: %s", body)
	}
	if !strings.Contains(body, `href="https://example.test/"`) {
		t.Errorf("SITE_URL not substituted: %s", body)
	}
}

func TestCTALabelFollowsOpenSignup(t *testing.T) {
	// The label lives in the sidecar so Norwegian copy stays in one place
	// (apps/landing/src/copy.ts) instead of being duplicated into Go.
	closed := newHandler(t, defaults())
	if body := get(t, closed, "/").Body.String(); !strings.Contains(body, "Sign in") {
		t.Errorf("closed signup should say Sign in: %s", body)
	}
	if body := get(t, closed, "/nb/").Body.String(); !strings.Contains(body, "Logg inn") {
		t.Errorf("closed signup, nb should say Logg inn: %s", body)
	}

	cfg := defaults()
	cfg.OpenSignup = true
	open := newHandler(t, cfg)
	if body := get(t, open, "/").Body.String(); !strings.Contains(body, "Get started") {
		t.Errorf("open signup should say Get started: %s", body)
	}
	if body := get(t, open, "/nb/").Body.String(); !strings.Contains(body, "Kom i gang") {
		t.Errorf("open signup, nb should say Kom i gang: %s", body)
	}
}

func TestRobotsAndNoindexFollowIndexable(t *testing.T) {
	// Fail-safe: anything but an explicit INDEXABLE keeps the host out of
	// the index, and the header does the work the build-time <meta> used to.
	closed := newHandler(t, defaults())
	rec := get(t, closed, "/robots.txt")
	if !strings.Contains(rec.Body.String(), "Disallow: /") {
		t.Errorf("robots.txt = %q, want Disallow", rec.Body.String())
	}
	if got := get(t, closed, "/").Header().Get("X-Robots-Tag"); got != "noindex, nofollow" {
		t.Errorf("X-Robots-Tag = %q, want noindex, nofollow", got)
	}

	cfg := defaults()
	cfg.Indexable = true
	open := newHandler(t, cfg)
	rec = get(t, open, "/robots.txt")
	if !strings.Contains(rec.Body.String(), "Allow: /") {
		t.Errorf("indexable robots.txt = %q, want Allow", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Sitemap: https://pjokk.no/sitemap.xml") {
		t.Errorf("indexable robots.txt missing sitemap: %q", rec.Body.String())
	}
	if got := get(t, open, "/").Header().Get("X-Robots-Tag"); got != "" {
		t.Errorf("indexable X-Robots-Tag = %q, want empty", got)
	}
}

func TestSitemapOnlyWhenIndexable(t *testing.T) {
	if rec := get(t, newHandler(t, defaults()), "/sitemap.xml"); rec.Code != http.StatusNotFound {
		t.Errorf("non-indexable sitemap = %d, want 404", rec.Code)
	}

	cfg := defaults()
	cfg.Indexable = true
	rec := get(t, newHandler(t, cfg), "/sitemap.xml")
	if rec.Code != http.StatusOK {
		t.Fatalf("sitemap = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	// Derived from the embedded tree, so a new document appears without
	// anyone remembering to update a list — every prerendered page, both
	// languages, each carrying the hreflang pair.
	for _, loc := range []string{
		"<loc>https://pjokk.no/</loc>",
		"<loc>https://pjokk.no/privacy</loc>",
		"<loc>https://pjokk.no/terms</loc>",
		"<loc>https://pjokk.no/nb/</loc>",
		"<loc>https://pjokk.no/nb/privacy</loc>",
		"<loc>https://pjokk.no/nb/terms</loc>",
	} {
		if !strings.Contains(body, loc) {
			t.Errorf("sitemap missing %s:\n%s", loc, body)
		}
	}
	if !strings.Contains(body, `hreflang="nb" href="https://pjokk.no/nb/privacy"`) {
		t.Errorf("sitemap missing hreflang alternates:\n%s", body)
	}
}

func TestSecurityHeadersForbidScript(t *testing.T) {
	// The landing site is zero-JavaScript by design, so its CSP can be
	// strictly tighter than the SPA's: nothing may execute at all.
	h := get(t, newHandler(t, defaults()), "/").Header()
	csp := h.Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'none'") {
		t.Errorf("CSP = %q, want script-src 'none'", csp)
	}
	for name, want := range map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"Referrer-Policy":           "same-origin",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	} {
		if got := h.Get(name); got != want {
			t.Errorf("header %s = %q, want %q", name, got, want)
		}
	}
}

func TestServesStaticAssets(t *testing.T) {
	rec := get(t, newHandler(t, defaults()), "/og.png")
	if rec.Code != http.StatusOK {
		t.Errorf("GET /og.png = %d, want 200", rec.Code)
	}
}
