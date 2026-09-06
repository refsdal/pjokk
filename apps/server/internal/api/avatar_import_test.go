package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// pictureServer serves one PNG (or a failure) over TLS and counts hits —
// the import requires https, and httptest's TLS client trusts its own cert.
func pictureServer(t *testing.T, status int) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(solidPNG(t, 96, 96))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func setGoogleImage(t *testing.T, a *testrig.AppRig, userID, url string) {
	t.Helper()
	if _, err := a.Rig.Pool.Exec(context.Background(), `UPDATE "users" SET "image" = $1 WHERE "id" = $2`, url, userID); err != nil {
		t.Fatal(err)
	}
}

func allowAll(string) bool { return true }

func TestGoogleAvatarIsImportedOnceOnFirstMe(t *testing.T) {
	a := testrig.App(t)
	srv, hits := pictureServer(t, http.StatusOK)
	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{Client: srv.Client(), AllowedHost: allowAll}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo=s96-c")
	cookie := a.SignIn("g@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d %s", res.Status, res.Raw)
	}
	if res.JSON["avatarUrl"] == nil {
		t.Fatalf("avatarUrl still null after import: %s", res.Raw)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Errorf("objects = %v, want 1", got)
	}

	a.Do(http.MethodGet, "/api/me", cookie, nil)
	if n := atomic.LoadInt32(hits); n != 1 {
		t.Errorf("picture fetched %d times, want exactly once", n)
	}
}

func TestGoogleAvatarImportNeverFetchesOtherHosts(t *testing.T) {
	a := testrig.App(t)
	srv, hits := pictureServer(t, http.StatusOK)
	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{Client: srv.Client(), AllowedHost: api.GoogleAvatarHost}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo")
	cookie := a.SignIn("g@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.JSON["avatarUrl"] != nil {
		t.Errorf("avatarUrl = %v, want null", res.JSON["avatarUrl"])
	}
	if n := atomic.LoadInt32(hits); n != 0 {
		t.Errorf("a non-Google host was fetched %d times", n)
	}
}

func TestGoogleAvatarImportFailureIsAttemptedOnce(t *testing.T) {
	a := testrig.App(t)
	srv, hits := pictureServer(t, http.StatusInternalServerError)
	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{Client: srv.Client(), AllowedHost: allowAll}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo")
	cookie := a.SignIn("g@example.com")

	for i := 0; i < 2; i++ {
		res := a.Do(http.MethodGet, "/api/me", cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("GET /api/me must not fail because Google did: %d %s", res.Status, res.Raw)
		}
		if res.JSON["avatarUrl"] != nil {
			t.Errorf("avatarUrl = %v, want null", res.JSON["avatarUrl"])
		}
	}
	if n := atomic.LoadInt32(hits); n != 1 {
		t.Errorf("failed import retried: %d fetches, want 1", n)
	}
	p, err := a.Deps.Q.GetUserProfile(context.Background(), id)
	if err != nil || !p.AvatarImportedAt.Valid {
		t.Errorf("avatar_imported_at not marked after a failed attempt (err %v)", err)
	}
}

// TestGoogleAvatarImportRefusesRedirectsOffTheAllowlist proves the fix for
// the SSRF gap CheckRedirect closes: an allowlisted host redirecting to a
// non-allowlisted one must never be followed. The AllowedHost here accepts
// only 127.0.0.1 — srv.URL's host — so the redirect to "localhost" (same
// process, different hostname) must be refused before any request reaches
// it.
func TestGoogleAvatarImportRefusesRedirectsOffTheAllowlist(t *testing.T) {
	a := testrig.App(t)
	var hits int32
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		port := srv.URL[strings.LastIndex(srv.URL, ":")+1:]
		http.Redirect(w, r, "https://localhost:"+port+"/photo", http.StatusFound)
	}))
	t.Cleanup(srv.Close)

	a.Configure(func(d *api.Deps) {
		d.AvatarImport = &api.AvatarImporter{
			Client:      srv.Client(),
			AllowedHost: func(h string) bool { return h == "127.0.0.1" },
		}
	})
	id := a.SignUp("Google Person", "g@example.com")
	setGoogleImage(t, a, id, srv.URL+"/photo")
	cookie := a.SignIn("g@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.JSON["avatarUrl"] != nil {
		t.Errorf("avatarUrl = %v, want null", res.JSON["avatarUrl"])
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Errorf("redirecting server hit %d times, want 1", n)
	}
}

func TestGoogleAvatarHost(t *testing.T) {
	for host, want := range map[string]bool{
		"lh3.googleusercontent.com":       true,
		"googleusercontent.com":           true,
		"evil-googleusercontent.com":      false,
		"googleusercontent.com.evil.test": false,
		"localhost":                       false,
	} {
		if got := api.GoogleAvatarHost(host); got != want {
			t.Errorf("GoogleAvatarHost(%q) = %v, want %v", host, got, want)
		}
	}
}
