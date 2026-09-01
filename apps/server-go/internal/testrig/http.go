// This file adds the HTTP-level rig on top of Setup's Postgres rig: a full
// api.NewHandler wired against real collaborators (Task 4's auth service,
// Task 6's storage, a recording stand-in for Task 7's push, an in-process
// rate limiter), driven with real *http.Request/ResponseRecorder round
// trips rather than by calling handler functions directly.
//
// It is the Go port of apps/api/test/helpers.ts's rig()/signIn()/api()
// trio: Task 9's route tests build on AppRig instead of reassembling Deps
// by hand in every _test.go file.
package testrig

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/storage"
)

// testAuthSecret is a fixed 32+ byte value; auth.New refuses anything
// shorter (see auth.Config.Secret).
const testAuthSecret = "pjokk-testrig-auth-secret-value-0123456789"

// rigPassword is the credential every AppRig-created account uses.
// scrypt/argon-family hashing is the expensive part of sign-in, not the
// value itself, so unlike apps/api/test/helpers.ts's cached-hash trick
// there is nothing to precompute here — CreateUser hashes it fresh per
// call, which is cheap enough at Go test scale.
const rigPassword = "Testrig-password-123"

// rigAppURL is http:, deliberately: auth.New sets the Limen session cookie
// Secure only when AppURL starts with "https:" (see auth.go), and Do drives
// requests straight through httptest.NewRequest rather than a TLS listener.
const rigAppURL = "http://127.0.0.1"

// sessionCookieName mirrors auth.go's unexported constant of the same name;
// duplicated here because AppRig only ever needs the one name and pulling
// in an export for it would be more machinery than the constant itself.
const sessionCookieName = "limen_session"

// RecordingPush is a push.Sender that records every payload instead of
// delivering it, keyed by the user it was sent to. Route tests that assert
// "a reminder was queued" read Sent/Count rather than standing up a fake
// push service or a real browser subscription.
type RecordingPush struct {
	mu   sync.Mutex
	sent map[string][]push.PushPayload
}

var _ push.Sender = (*RecordingPush)(nil)

// NewRecordingPush builds an empty RecordingPush.
func NewRecordingPush() *RecordingPush {
	return &RecordingPush{sent: make(map[string][]push.PushPayload)}
}

// ToUser records p under userID and reports one delivery, always
// succeeding — the point of this Sender is to observe what was sent, not to
// exercise delivery failure paths (WebPush's own tests cover those).
func (p *RecordingPush) ToUser(_ context.Context, userID string, payload push.PushPayload) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent[userID] = append(p.sent[userID], payload)
	return 1, nil
}

// Sent returns every payload recorded for userID, in send order.
func (p *RecordingPush) Sent(userID string) []push.PushPayload {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]push.PushPayload, len(p.sent[userID]))
	copy(out, p.sent[userID])
	return out
}

// Count reports how many payloads have been recorded for userID.
func (p *RecordingPush) Count(userID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.sent[userID])
}

// protectedRoute is one MountProtected registration, applied to the mux
// api.NewHandler builds each time the rig's handler is (re)built.
type protectedRoute struct {
	pattern string
	handler http.HandlerFunc
}

// AppRig is the HTTP-level test rig: a full api.NewHandler wired against a
// real, isolated Postgres (embeds *Rig), in-memory object storage, and a
// RecordingPush, ready to drive with Do/DoArray.
//
// Not safe for concurrent use from multiple goroutines beyond what *testing.T
// itself allows — like Setup's Rig, an AppRig belongs to one test.
type AppRig struct {
	t    *testing.T
	Rig  *Rig
	Deps api.Deps
	Push *RecordingPush

	mu          sync.Mutex
	nowOverride time.Time // zero => wall clock (see SetNow)
	routes      []protectedRoute
	handler     http.Handler // rebuilt lazily; nil means "stale, rebuild me"
}

// App builds an AppRig: a fresh Postgres rig (via Setup), a real auth.Service
// against it, in-memory storage, a Postgres-backed rate limiter, and a
// RecordingPush — the same shape of Deps cmd/pjokk's composition root will
// build, minus the two swaps a test wants (memory storage, recording push).
func App(t *testing.T) *AppRig {
	t.Helper()

	rig := Setup(t)

	svc, err := auth.New(auth.Config{
		AppURL:     rigAppURL,
		Secret:     testAuthSecret,
		OpenSignup: false,
		Pool:       rig.Pool,
	})
	if err != nil {
		t.Fatalf("testrig: auth.New: %v", err)
	}

	// VAPID keys are generated fresh per rig rather than hard-coded: only
	// their presence matters here (api.Deps.VAPIDPublicKey just has to be
	// non-empty for the future /api/push/config route), and the private key
	// is discarded — push delivery itself goes through Push, not WebPush.
	_, vapidPublic, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("testrig: generate VAPID keys: %v", err)
	}

	recordingPush := NewRecordingPush()

	ar := &AppRig{
		t:    t,
		Rig:  rig,
		Push: recordingPush,
	}
	ar.Deps = api.Deps{
		Pool:             rig.Pool,
		Q:                rig.Q,
		Auth:             svc,
		Storage:          storage.NewMemory(),
		RateLimit:        ratelimit.NewPostgres(rig.Q),
		Push:             recordingPush,
		Now:              ar.now,
		AppURL:           rigAppURL,
		VAPIDPublicKey:   vapidPublic,
		TrustedProxyHops: 0,
	}

	ar.mu.Lock()
	ar.rebuildLocked()
	ar.mu.Unlock()

	return ar
}

// now backs api.Deps.Now: the wall clock unless SetNow pinned it.
func (a *AppRig) now() time.Time {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.nowOverride.IsZero() {
		return time.Now()
	}
	return a.nowOverride
}

// SetNow pins the rig's clock to t; every subsequent call the app makes
// through Deps.Now (rate-limit expiry, API-key freshness, reminder timing,
// …) sees t instead of the wall clock. Pass the zero time.Time to revert to
// the wall clock.
func (a *AppRig) SetNow(t time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nowOverride = t
}

// handlerFor returns the rig's handler, rebuilding it first if a
// MountProtected call since the last build left it stale.
func (a *AppRig) handlerFor() http.Handler {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handler == nil {
		a.rebuildLocked()
	}
	return a.handler
}

// rebuildLocked builds a.handler from a.Deps plus any MountProtected routes.
// Callers must hold a.mu.
func (a *AppRig) rebuildLocked() {
	deps := a.Deps
	if len(a.routes) > 0 {
		routes := a.routes // snapshot: api.NewHandler's ExtraRoutes runs once, at build time
		deps.ExtraRoutes = func(mux *http.ServeMux, protect func(http.Handler) http.Handler) {
			for _, route := range routes {
				mux.Handle(route.pattern, protect(route.handler))
			}
		}
	}
	a.handler = api.NewHandler(deps)
}

// MountProtected registers a test-only handler at pattern (a net/http
// ServeMux pattern, e.g. "GET /api/_test/probe") behind the exact
// Session + RequireFamily chain every real family-scoped route runs behind.
//
// It exists so a self-test can prove that chain end-to-end (200 with a
// family session, 403 NO_FAMILY without one) before any real domain route
// exists — never reach for it to assert the behaviour of a shipped
// endpoint; test that through Do against the real path instead.
func (a *AppRig) MountProtected(pattern string, h http.HandlerFunc) {
	a.t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.routes = append(a.routes, protectedRoute{pattern: pattern, handler: h})
	a.handler = nil // force a rebuild before the next request
}

// SignUp creates a user with the rig's fixed test password (see rigPassword)
// and returns its id. Equivalent to apps/api/test/helpers.ts's createUser,
// minus the caller having to think about the credential.
func (a *AppRig) SignUp(name, email string) string {
	a.t.Helper()
	id, err := a.Deps.Auth.CreateUser(context.Background(), name, email, rigPassword)
	if err != nil {
		a.t.Fatalf("testrig: SignUp(%q): %v", email, err)
	}
	return id
}

// signInCookie drives the real POST /api/auth/signin/credential route and
// returns the limen_session cookie the response set.
func (a *AppRig) signInCookie(email string) *http.Cookie {
	a.t.Helper()
	body, err := json.Marshal(map[string]string{"credential": email, "password": rigPassword})
	if err != nil {
		a.t.Fatalf("testrig: marshal sign-in body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/signin/credential", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.handlerFor().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		a.t.Fatalf("testrig: sign in %q: %d %s", email, rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName && c.Value != "" {
			return c
		}
	}
	a.t.Fatalf("testrig: sign in %q: no session cookie in response: %s", email, rec.Body.String())
	return nil // unreachable: Fatalf stops the goroutine
}

// SignIn drives the real credential sign-in route and returns a ready-to-use
// Cookie header value ("limen_session=..."). Mirrors apps/api/test/
// helpers.ts's signIn() over Limen's better-auth predecessor.
func (a *AppRig) SignIn(email string) string {
	a.t.Helper()
	c := a.signInCookie(email)
	return c.Name + "=" + c.Value
}

// NewFamily creates a user, a family they administer (CreateFamily's
// configured creator role — see auth.New's WithCreatorRole — makes them an
// admin member as part of creating it), points a fresh session at that
// family, and returns the family id and a ready-to-use Cookie header value.
// The standard "one admin, one family" starting point most route tests
// want; call NewBaby separately for a baby.
func (a *AppRig) NewFamily(name, adminEmail string) (familyID, cookie string) {
	a.t.Helper()
	ctx := context.Background()

	userID := a.SignUp("Rig admin", adminEmail)

	familyID, err := a.Deps.Auth.CreateFamily(ctx, userID, name)
	if err != nil {
		a.t.Fatalf("testrig: CreateFamily(%q): %v", name, err)
	}

	c := a.signInCookie(adminEmail)
	if err := a.Deps.Auth.SetActiveFamily(ctx, c.Value, familyID); err != nil {
		a.t.Fatalf("testrig: SetActiveFamily(%q, %q): %v", c.Value, familyID, err)
	}

	return familyID, c.Name + "=" + c.Value
}

// NewBaby inserts a baby directly via sqlc — bypassing HTTP, since Task 9's
// /api/babies routes are what the HTTP path itself exercises — and returns
// its id.
func (a *AppRig) NewBaby(familyID, name string) string {
	a.t.Helper()
	baby, err := a.Deps.Q.CreateBaby(context.Background(), gen.CreateBabyParams{
		FamilyID:  familyID,
		Name:      name,
		BirthDate: pgtype.Timestamptz{Time: time.Date(2025, 10, 20, 0, 0, 0, 0, time.UTC), Valid: true},
	})
	if err != nil {
		a.t.Fatalf("testrig: NewBaby(%q, %q): %v", familyID, name, err)
	}
	return baby.ID
}

// Result is one HTTP response, decoded eagerly so assertions read like plain
// Go values instead of every test re-parsing a body. JSON is nil when Raw
// is empty or is not a JSON object (e.g. an array body — see DoArray, or a
// non-JSON body).
type Result struct {
	Status int
	JSON   map[string]any
	Raw    []byte
	Header http.Header
}

// ArrayResult is Result's counterpart for endpoints whose success body is a
// JSON array rather than an object.
type ArrayResult struct {
	Status int
	JSON   []any
	Raw    []byte
	Header http.Header
}

// Do issues method/path against the rig's handler, attaching cookie as the
// Cookie header when non-empty and marshalling body (nil skips the request
// body entirely) as JSON. Mirrors apps/api/test/helpers.ts's api().
func (a *AppRig) Do(method, path, cookie string, body any) *Result {
	a.t.Helper()
	rec := a.roundTrip(method, path, cookie, body)

	raw := rec.Body.Bytes()
	result := &Result{Status: rec.Code, Raw: raw, Header: rec.Header()}
	if len(raw) > 0 {
		var v map[string]any
		if err := json.Unmarshal(raw, &v); err == nil {
			result.JSON = v
		}
	}
	return result
}

// DoArray is Do for endpoints whose success body is a JSON array.
func (a *AppRig) DoArray(method, path, cookie string, body any) *ArrayResult {
	a.t.Helper()
	rec := a.roundTrip(method, path, cookie, body)

	raw := rec.Body.Bytes()
	result := &ArrayResult{Status: rec.Code, Raw: raw, Header: rec.Header()}
	if len(raw) > 0 {
		var v []any
		if err := json.Unmarshal(raw, &v); err == nil {
			result.JSON = v
		}
	}
	return result
}

func (a *AppRig) roundTrip(method, path, cookie string, body any) *httptest.ResponseRecorder {
	a.t.Helper()

	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			a.t.Fatalf("testrig: marshal request body for %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(b)
	}

	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	rec := httptest.NewRecorder()
	a.handlerFor().ServeHTTP(rec, req)
	return rec
}
