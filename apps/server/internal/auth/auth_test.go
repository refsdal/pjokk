package auth_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// testSecret is the 32+ byte AUTH_SECRET stand-in. Limen itself wants exactly
// 32 bytes; auth.New hashes whatever it is given, which is the point of
// passing something that is neither 32 bytes nor pretty.
const testSecret = "pjokk-test-auth-secret-value-0123456789"

// signInPassword satisfies the credential plugin's default policy (8+ chars,
// an uppercase letter, a digit).
const signInPassword = "Testpass123"

type fixture struct {
	svc  auth.Service
	rig  *testrig.Rig
	mux  *http.ServeMux
	ctx  context.Context
	tabs *testing.T
}

// newFixture builds a service against the rig database with signup closed
// and no Google credentials — the shipped default (OPEN_SIGNUP=0, a
// self-hoster who has not configured OAuth).
func newFixture(t *testing.T, openSignup bool) *fixture {
	t.Helper()

	rig := testrig.Setup(t)
	svc, err := auth.New(auth.Config{
		AppURL:     "http://localhost:3000",
		Secret:     testSecret,
		OpenSignup: openSignup,
		Pool:       rig.Pool,
	})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle(auth.BasePath+"/", svc.Handler())

	return &fixture{svc: svc, rig: rig, mux: mux, ctx: context.Background(), tabs: t}
}

// post sends a JSON request through the mounted handler, the way a browser
// would reach it, and returns the recorder.
func (f *fixture) post(path, body string) *httptest.ResponseRecorder {
	f.tabs.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	return rec
}

// get sends a GET through the mounted handler, optionally signed in.
func (f *fixture) get(path string, cookie *http.Cookie) *httptest.ResponseRecorder {
	f.tabs.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	return rec
}

// ban flips users.banned, the way the admin console will.
func (f *fixture) ban(userID string) {
	f.tabs.Helper()
	if _, err := f.rig.Pool.Exec(f.ctx, `UPDATE "users" SET "banned" = true WHERE "id" = $1`, userID); err != nil {
		f.tabs.Fatalf("ban user: %v", err)
	}
}

// promote makes a user a system administrator, the way the admin console
// will.
func (f *fixture) promote(userID string) {
	f.tabs.Helper()
	if _, err := f.rig.Pool.Exec(f.ctx, `UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, userID); err != nil {
		f.tabs.Fatalf("promote to system admin: %v", err)
	}
}

// sessionCookie extracts the session cookie a response set, failing the test
// when there is none.
func (f *fixture) sessionCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	f.tabs.Helper()
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == "limen_session" && cookie.Value != "" {
			return cookie
		}
	}
	f.tabs.Fatalf("no session cookie in response: %d %s", rec.Code, rec.Body.String())
	return nil
}

// signedInRequest builds a request carrying the given session cookie.
func signedInRequest(cookie *http.Cookie) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.AddCookie(cookie)
	return req
}

// signIn creates a user and signs them in through the real HTTP route,
// returning the user id and the session cookie.
func (f *fixture) signIn(name, email string) (string, *http.Cookie) {
	f.tabs.Helper()

	userID, err := f.svc.CreateUser(f.ctx, name, email, signInPassword)
	if err != nil {
		f.tabs.Fatalf("CreateUser: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"credential": email, "password": signInPassword})
	rec := f.post(auth.BasePath+"/signin/credential", string(body))
	if rec.Code != http.StatusOK {
		f.tabs.Fatalf("sign in: got %d, body %s", rec.Code, rec.Body.String())
	}
	return userID, f.sessionCookie(rec)
}

// (a) Closed signup means the credential signup route does not exist.
func TestSignupRouteDisabledWhenSignupClosed(t *testing.T) {
	f := newFixture(t, false)

	rec := f.post(auth.BasePath+"/signup/credential", `{"email":"nope@example.com","password":"Testpass123"}`)

	if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("signup should be unreachable with OPEN_SIGNUP=0: got %d, body %s", rec.Code, rec.Body.String())
	}
}

func TestSignupRouteEnabledWhenSignupOpen(t *testing.T) {
	f := newFixture(t, true)

	// Reached, and therefore answered by the handler rather than the router.
	// The body is deliberately valid so a 404 can only mean "route missing".
	rec := f.post(auth.BasePath+"/signup/credential", `{"email":"open@example.com","password":"Testpass123"}`)

	if rec.Code == http.StatusNotFound || rec.Code == http.StatusMethodNotAllowed {
		t.Fatalf("signup should be reachable with OPEN_SIGNUP=1: got %d, body %s", rec.Code, rec.Body.String())
	}
}

// Google sign-in is optional. When it is configured, the plugin has to come
// up (its token encryption needs a 32-byte key, which it borrows from
// Config.Secret — a mismatch fails at limen.New, not at first use) and mount
// under our base path, so the callback URL registered with Google
// ({APP_URL}/api/auth/oauth/google/callback) actually resolves.
func TestGoogleOAuthRoutesMountUnderBasePath(t *testing.T) {
	rig := testrig.Setup(t)
	svc, err := auth.New(auth.Config{
		AppURL:             "http://localhost:3000",
		Secret:             testSecret,
		GoogleClientID:     "test-client-id",
		GoogleClientSecret: "test-client-secret",
		Pool:               rig.Pool,
	})
	if err != nil {
		t.Fatalf("auth.New with Google credentials: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle(auth.BasePath+"/", svc.Handler())

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, auth.BasePath+"/oauth/google/authorize", nil))

	if rec.Code == http.StatusNotFound {
		t.Fatalf("the Google authorize route did not mount under %s", auth.BasePath)
	}
	// The handler answers with the authorization URL rather than a 302, so
	// the SPA can decide how to navigate. The URL is what matters: it proves
	// the plugin is live AND that the callback Google must be configured
	// with is the one this base path produces.
	body := rec.Body.String()
	if !strings.Contains(body, "accounts.google.com") {
		t.Fatalf("authorize did not produce a Google URL: %d %s", rec.Code, body)
	}
	const callback = "http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Foauth%2Fgoogle%2Fcallback"
	if !strings.Contains(body, callback) {
		t.Fatalf("authorize used an unexpected callback URL: %s", body)
	}
}

// Without credentials the OAuth plugin is not registered at all, so a
// self-hoster who never set up Google still gets a working instance rather
// than a route that 500s halfway through a redirect.
func TestGoogleOAuthAbsentWithoutCredentials(t *testing.T) {
	f := newFixture(t, false)

	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, auth.BasePath+"/oauth/google/authorize", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 for the Google route with no credentials configured, got %d: %s", rec.Code, rec.Body.String())
	}
}

// (b) CreateUser + sign-in over HTTP yields a cookie SessionFromRequest
// resolves back to the user, with our own columns attached.
func TestSignInThenSessionFromRequest(t *testing.T) {
	f := newFixture(t, false)

	userID, cookie := f.signIn("Kari Nordmann", "kari@example.com")

	session, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if session == nil {
		t.Fatal("SessionFromRequest returned no session for a fresh sign-in")
	}
	if session.UserID != userID {
		t.Errorf("UserID = %q, want %q", session.UserID, userID)
	}
	if session.Email != "kari@example.com" {
		t.Errorf("Email = %q, want kari@example.com", session.Email)
	}
	if session.Name != "Kari Nordmann" {
		t.Errorf("Name = %q, want Kari Nordmann (additional fields must reach our users.name column)", session.Name)
	}
	if session.Role != "" {
		t.Errorf("Role = %q, want empty for an ordinary user", session.Role)
	}
	if session.Banned {
		t.Error("Banned = true for a fresh user")
	}
	if session.ActiveFamilyID != "" {
		t.Errorf("ActiveFamilyID = %q, want empty before any family is created", session.ActiveFamilyID)
	}
	if session.Token == "" {
		t.Error("Token is empty")
	}
	if session.ImpersonatedBy != "" {
		t.Errorf("ImpersonatedBy = %q, want empty", session.ImpersonatedBy)
	}
}

// Limen's sessions slide: validating one whose expiry is within UpdateAge
// (1 day of a 7-day life) extends it in the database AND hands back a
// refreshed cookie. Only Limen's own middleware writes that cookie, and Pjokk
// does not use it — so the resolver has to, or an active user's cookie
// eventually expires under them while the row keeps being extended.
//
// The near-expiry state is produced by ageing the session two days: Limen
// derives "when was this last extended" as expires_at minus the session
// duration, so a session created two days ago and expiring in five is one day
// past its update age. created_at moves with it because Limen reads a session
// whose (expires_at - created_at) is under the full duration as a short,
// deliberately non-extending "remember me was unchecked" session.
func TestSessionFromRequestRefreshingReissuesTheCookie(t *testing.T) {
	f := newFixture(t, false)

	_, cookie := f.signIn("Refresh Me", "refresh@example.com")
	if _, err := f.rig.Pool.Exec(f.ctx, `
		UPDATE "sessions"
		SET "created_at" = now() - interval '2 days',
		    "expires_at" = now() + interval '5 days'
		WHERE "token" = $1`,
		cookie.Value,
	); err != nil {
		t.Fatalf("age the session: %v", err)
	}

	rec := httptest.NewRecorder()
	session, err := f.svc.SessionFromRequestRefreshing(rec, signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequestRefreshing: %v", err)
	}
	if session == nil {
		t.Fatal("no session for a valid, near-expiry cookie")
	}

	refreshed := f.sessionCookie(rec)
	if refreshed.Value != cookie.Value {
		t.Errorf("refreshed cookie value = %q, want the same token %q", refreshed.Value, cookie.Value)
	}
	if refreshed.MaxAge <= 0 {
		t.Errorf("refreshed cookie Max-Age = %d, want a fresh positive lifetime", refreshed.MaxAge)
	}

	// The extension is persisted too, not just announced to the browser.
	var expiresAt time.Time
	if err := f.rig.Pool.QueryRow(f.ctx,
		`SELECT "expires_at" FROM "sessions" WHERE "token" = $1`, cookie.Value,
	).Scan(&expiresAt); err != nil {
		t.Fatalf("read session expiry: %v", err)
	}
	if time.Until(expiresAt) < 6*24*time.Hour {
		t.Errorf("session expires in %s, want the full duration back", time.Until(expiresAt))
	}
}

// The other half of the contract: a session nowhere near its refresh window
// must not have its cookie rewritten on every request.
func TestSessionFromRequestRefreshingLeavesFreshSessionsAlone(t *testing.T) {
	f := newFixture(t, false)

	_, cookie := f.signIn("Fresh", "fresh@example.com")

	rec := httptest.NewRecorder()
	session, err := f.svc.SessionFromRequestRefreshing(rec, signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequestRefreshing: %v", err)
	}
	if session == nil {
		t.Fatal("no session for a fresh cookie")
	}
	if got := rec.Result().Cookies(); len(got) != 0 {
		t.Errorf("a fresh session set %d cookies, want none", len(got))
	}
}

func TestSessionFromRequestWithoutCookie(t *testing.T) {
	f := newFixture(t, false)

	session, err := f.svc.SessionFromRequest(httptest.NewRequest(http.MethodGet, "/api/summary", nil))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if session != nil {
		t.Fatalf("want nil session for an anonymous request, got %+v", session)
	}
}

// A banned user is indistinguishable from a signed-out one.
func TestBannedUserHasNoSession(t *testing.T) {
	f := newFixture(t, false)

	userID, cookie := f.signIn("Banned Person", "banned@example.com")
	f.ban(userID)

	session, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if session != nil {
		t.Fatalf("banned user must read as signed out, got %+v", session)
	}
}

// SessionFromRequest guards our own routes; Limen's routes never ask us, so
// the Handler has to reject a banned session itself. Signing out stays open,
// or a banned user's browser keeps a cookie it can never clear.
func TestBannedUserRejectedOnLimenRoutes(t *testing.T) {
	f := newFixture(t, false)

	userID, cookie := f.signIn("Banned Person", "banned@example.com")

	// Before the ban the route answers normally, so the assertion below is
	// about the ban and not about the route being broken.
	if rec := f.get(auth.BasePath+"/me", cookie); rec.Code != http.StatusOK {
		t.Fatalf("precondition: /me before ban = %d, body %s", rec.Code, rec.Body.String())
	}

	f.ban(userID)

	if rec := f.get(auth.BasePath+"/me", cookie); rec.Code != http.StatusUnauthorized {
		t.Errorf("/me after ban = %d, want 401; body %s", rec.Code, rec.Body.String())
	}
	if rec := f.get(auth.BasePath+"/organizations", cookie); rec.Code != http.StatusUnauthorized {
		t.Errorf("organizations list after ban = %d, want 401; body %s", rec.Code, rec.Body.String())
	}

	// Signout is the one route a banned session may still reach.
	req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/signout", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized {
		t.Errorf("signout must stay reachable for a banned session, got 401: %s", rec.Body.String())
	}
}

// An anonymous request is Limen's business, not the guard's.
func TestBannedGuardIgnoresAnonymousRequests(t *testing.T) {
	f := newFixture(t, false)

	rec := f.get(auth.BasePath+"/me", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("/me anonymous = %d, want Limen's own 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "account suspended") {
		t.Fatalf("the banned guard answered an anonymous request: %s", rec.Body.String())
	}
}

// Limen mounts a large default API. Only the routes the SPA needs may be
// reachable; everything else has to be off, not merely undocumented.
func TestLimenRouteAllowlist(t *testing.T) {
	f := newFixture(t, false)

	_, cookie := f.signIn("Kari", "kari@example.com")

	disabled := []struct{ method, path string }{
		{http.MethodGet, auth.BasePath + "/sessions"},
		{http.MethodPost, auth.BasePath + "/revoke-sessions"},
		{http.MethodGet, auth.BasePath + "/organizations/members"},
		{http.MethodGet, auth.BasePath + "/organizations/active"},
		{http.MethodPost, auth.BasePath + "/organizations/leave"},
		{http.MethodPost, auth.BasePath + "/organizations/check-slug"},
		{http.MethodPost, auth.BasePath + "/organizations/invitations"},
		{http.MethodPost, auth.BasePath + "/organizations/invitations/respond"},
		{http.MethodPost, auth.BasePath + "/organizations/invitations/cancel"},
		{http.MethodGet, auth.BasePath + "/organizations/invitations"},
		{http.MethodDelete, auth.BasePath + "/organizations/members/m1"},
		{http.MethodPost, auth.BasePath + "/organizations/members/m1/roles/assign"},
		{http.MethodPost, auth.BasePath + "/organizations/members/m1/roles/revoke"},
		{http.MethodPatch, auth.BasePath + "/organizations/o1"},
		{http.MethodDelete, auth.BasePath + "/organizations/o1"},
		{http.MethodPost, auth.BasePath + "/passwords/request-reset"},
		{http.MethodPost, auth.BasePath + "/passwords/reset"},
		{http.MethodPost, auth.BasePath + "/passwords/change"},
		{http.MethodPut, auth.BasePath + "/passwords"},
		{http.MethodPost, auth.BasePath + "/usernames/check"},
	}
	for _, route := range disabled {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		f.mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s %s is reachable (%d): %s", route.method, route.path, rec.Code, rec.Body.String())
		}
	}

	// The kept routes must still answer — an allowlist that turns everything
	// off is not a safer allowlist, it is a broken app.
	kept := []struct{ method, path string }{
		{http.MethodGet, auth.BasePath + "/me"},
		{http.MethodGet, auth.BasePath + "/organizations"},
		{http.MethodGet, auth.BasePath + "/organizations/me"},
	}
	for _, route := range kept {
		rec := f.get(route.path, cookie)
		if rec.Code == http.StatusNotFound || rec.Code == http.StatusMethodNotAllowed {
			t.Errorf("%s %s should be reachable, got %d", route.method, route.path, rec.Code)
		}
	}

	// POST routes the SPA needs: reached, therefore answered by a handler.
	for _, path := range []string{auth.BasePath + "/organizations", auth.BasePath + "/organizations/switch"} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"name":"Nordmann"}`))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		f.mux.ServeHTTP(rec, req)

		if rec.Code == http.StatusNotFound || rec.Code == http.StatusMethodNotAllowed {
			t.Errorf("POST %s should be reachable, got %d", path, rec.Code)
		}
	}
}

// (c) CreateFamily + AddMember + SetActiveFamily is reflected in the session.
func TestFamilyLifecycleReachesSession(t *testing.T) {
	f := newFixture(t, false)

	ownerID, ownerCookie := f.signIn("Owner", "owner@example.com")
	memberID, memberCookie := f.signIn("Member", "member@example.com")

	familyID, err := f.svc.CreateFamily(f.ctx, ownerID, "Nordmann")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	if familyID == "" {
		t.Fatal("CreateFamily returned an empty id")
	}

	// The creator is a family admin, recorded on Limen's own role table.
	assertRoles(t, f, familyID, ownerID, []string{auth.RoleAdmin})

	if err := f.svc.AddMember(f.ctx, familyID, memberID, auth.RoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	assertRoles(t, f, familyID, memberID, []string{auth.RoleMember})

	ownerSession, err := f.svc.SessionFromRequest(signedInRequest(ownerCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if err := f.svc.SetActiveFamily(f.ctx, ownerSession.Token, familyID); err != nil {
		t.Fatalf("SetActiveFamily: %v", err)
	}

	ownerSession, err = f.svc.SessionFromRequest(signedInRequest(ownerCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest after SetActiveFamily: %v", err)
	}
	if ownerSession.ActiveFamilyID != familyID {
		t.Errorf("ActiveFamilyID = %q, want %q", ownerSession.ActiveFamilyID, familyID)
	}

	// The member's own session is untouched by the owner switching families.
	memberSession, err := f.svc.SessionFromRequest(signedInRequest(memberCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest (member): %v", err)
	}
	if memberSession.ActiveFamilyID != "" {
		t.Errorf("member ActiveFamilyID = %q, want empty", memberSession.ActiveFamilyID)
	}

	// Promotion, then removal.
	membership := membershipOf(t, f, familyID, memberID)
	if err := f.svc.SetMemberRole(f.ctx, familyID, membership.ID, auth.RoleAdmin); err != nil {
		t.Fatalf("SetMemberRole: %v", err)
	}
	assertRoles(t, f, familyID, memberID, []string{auth.RoleAdmin})

	if err := f.svc.SetActiveFamily(f.ctx, memberSession.Token, familyID); err != nil {
		t.Fatalf("SetActiveFamily (member): %v", err)
	}
	if err := f.svc.RemoveMember(f.ctx, familyID, membership.ID); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}

	// Removal clears the family off the removed member's sessions, so they
	// cannot keep operating inside a family they no longer belong to.
	memberSession, err = f.svc.SessionFromRequest(signedInRequest(memberCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest after removal: %v", err)
	}
	if memberSession.ActiveFamilyID != "" {
		t.Errorf("removed member still has ActiveFamilyID %q", memberSession.ActiveFamilyID)
	}
	if _, err := f.rig.Q.GetMembership(f.ctx, gen.GetMembershipParams{
		OrganizationID: familyID,
		UserID:         memberID,
	}); err == nil {
		t.Error("membership row survived RemoveMember")
	}
}

// The tenancy middleware trusts active_organization_id as the family scope
// for every subsequent query, so pointing a session at a family the user is
// not in would be a straight cross-tenant read.
func TestSetActiveFamilyRejectsNonMember(t *testing.T) {
	f := newFixture(t, false)

	ownerID, _ := f.signIn("Owner", "owner@example.com")
	outsiderID, outsiderCookie := f.signIn("Outsider", "outsider@example.com")

	familyID, err := f.svc.CreateFamily(f.ctx, ownerID, "Nordmann")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	// The outsider has a family of their own, so this is "not a member of
	// THIS family" rather than "has no families at all".
	ownFamilyID, err := f.svc.CreateFamily(f.ctx, outsiderID, "Hansen")
	if err != nil {
		t.Fatalf("CreateFamily (outsider): %v", err)
	}

	outsider, err := f.svc.SessionFromRequest(signedInRequest(outsiderCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if err := f.svc.SetActiveFamily(f.ctx, outsider.Token, ownFamilyID); err != nil {
		t.Fatalf("SetActiveFamily on own family: %v", err)
	}

	err = f.svc.SetActiveFamily(f.ctx, outsider.Token, familyID)
	if !errors.Is(err, auth.ErrNotFamilyMember) {
		t.Fatalf("SetActiveFamily to a foreign family: err = %v, want ErrNotFamilyMember", err)
	}

	// And the session still points where it did.
	after, err := f.svc.SessionFromRequest(signedInRequest(outsiderCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest after rejection: %v", err)
	}
	if after.ActiveFamilyID != ownFamilyID {
		t.Fatalf("ActiveFamilyID = %q, want it unchanged at %q", after.ActiveFamilyID, ownFamilyID)
	}
}

// Family names repeat constantly. Two families with the same name must both
// be creatable — through our API and through Limen's own create route, which
// the allowlist keeps open for the SPA.
func TestFamilyNamesMayRepeat(t *testing.T) {
	f := newFixture(t, false)

	oneID, _ := f.signIn("One", "one@example.com")
	twoID, _ := f.signIn("Two", "two@example.com")
	// A third, still family-less user for the HTTP-route half of this test:
	// allowOrgCreation (Task 22 fix) permits self-serve founding only while a
	// user holds zero memberships, so reusing oneID/twoID here — both
	// already admins of a family from the CreateFamily calls below — would
	// conflate "family names may repeat" with that unrelated gate.
	_, cookie := f.signIn("Three", "three@example.com")

	first, err := f.svc.CreateFamily(f.ctx, oneID, "Hansen")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	second, err := f.svc.CreateFamily(f.ctx, twoID, "Hansen")
	if err != nil {
		t.Fatalf("second family with the same name: %v", err)
	}
	if first == second {
		t.Fatal("both families got the same id")
	}

	req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/organizations", strings.NewReader(`{"name":"Hansen"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("Limen's create route rejected a repeated family name: %d %s", rec.Code, rec.Body.String())
	}
}

// TestOrgCreationRestrictedToSystemAdminsAndFamilyLessUsers is a Task 22
// regression test for a real leak found while porting apps/api/test/
// security.test.ts's "only system admins can create families (H2)": the
// Go port had NO equivalent of auth.ts's allowUserToCreateOrganization gate.
// organizations:create stayed enabled in allowedRouteIDs (see New's own
// comment, "the family switcher") with nothing behind it, so ANY signed-in
// user — including one already belonging to a family — could hit
// POST /api/auth/organizations directly and found an arbitrary new family,
// admin of their own creation, entirely bypassing the closed-alpha
// invite-code gate CLAUDE.md commits to. Fixed by allowOrgCreation (auth.go),
// wired in as organization.WithAllowOrgCreation: a system admin may always
// create; anyone else may self-serve found exactly one family, while they
// hold zero memberships, and must go through an invite after that.
func TestOrgCreationRestrictedToSystemAdminsAndFamilyLessUsers(t *testing.T) {
	f := newFixture(t, false)

	create := func(cookie *http.Cookie) int {
		req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/organizations", strings.NewReader(`{"name":"Rogue family"}`))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		f.mux.ServeHTTP(rec, req)
		return rec.Code
	}

	// A brand-new, family-less user may self-serve found their first family.
	userID, cookie := f.signIn("Founder", "founder@example.com")
	if code := create(cookie); code != http.StatusCreated {
		t.Fatalf("first (family-less) create status = %d, want 201", code)
	}

	// The same now-member user may NOT found a second one.
	if code := create(cookie); code != http.StatusForbidden {
		t.Fatalf("second create by an existing member status = %d, want 403", code)
	}

	// Promoting them to system admin lifts the restriction, same as the TS
	// predecessor's H2 test (rig() denied, then role=admin allowed).
	f.promote(userID)
	if code := create(cookie); code != http.StatusCreated {
		t.Fatalf("sysadmin create status = %d, want 201", code)
	}

	// The internal CreateFamily entry point (invite/admin flows, tests)
	// enforces the identical rule for an ordinary already-member user, not
	// just the HTTP route.
	memberID, _ := f.signIn("Plain member", "plain-member@example.com")
	if _, err := f.svc.CreateFamily(f.ctx, memberID, "First"); err != nil {
		t.Fatalf("first CreateFamily for a family-less user: %v", err)
	}
	if _, err := f.svc.CreateFamily(f.ctx, memberID, "Second"); err == nil {
		t.Fatal("CreateFamily allowed an existing member to found a second family")
	}
}

func TestSetMemberRoleRejectsUnknownRole(t *testing.T) {
	f := newFixture(t, false)

	ownerID, _ := f.signIn("Owner", "owner@example.com")
	familyID, err := f.svc.CreateFamily(f.ctx, ownerID, "Nordmann")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	membership := membershipOf(t, f, familyID, ownerID)

	if err := f.svc.SetMemberRole(f.ctx, familyID, membership.ID, "superuser"); err == nil {
		t.Fatal("SetMemberRole accepted a role outside the family vocabulary")
	}
}

// A member id from another family must not be mutable through this family.
func TestMemberMutationIsFamilyScoped(t *testing.T) {
	f := newFixture(t, false)

	oneID, _ := f.signIn("One", "one@example.com")
	twoID, _ := f.signIn("Two", "two@example.com")

	familyOne, err := f.svc.CreateFamily(f.ctx, oneID, "One")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	familyTwo, err := f.svc.CreateFamily(f.ctx, twoID, "Two")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}

	foreign := membershipOf(t, f, familyTwo, twoID)

	if err := f.svc.RemoveMember(f.ctx, familyOne, foreign.ID); err == nil {
		t.Error("RemoveMember crossed a family boundary")
	}
	if err := f.svc.SetMemberRole(f.ctx, familyOne, foreign.ID, auth.RoleMember); err == nil {
		t.Error("SetMemberRole crossed a family boundary")
	}
}

// (d) Impersonation round trip.
func TestImpersonateAndStopImpersonating(t *testing.T) {
	f := newFixture(t, false)

	adminID, adminCookie := f.signIn("Sysadmin", "admin@example.com")
	targetID, _ := f.signIn("Target", "target@example.com")

	f.promote(adminID)

	adminSession, err := f.svc.SessionFromRequest(signedInRequest(adminCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if adminSession.Role != "admin" {
		t.Fatalf("Role = %q, want admin", adminSession.Role)
	}

	rec := httptest.NewRecorder()
	if err := f.svc.Impersonate(f.ctx, rec, signedInRequest(adminCookie), adminSession, targetID); err != nil {
		t.Fatalf("Impersonate: %v", err)
	}
	impersonatedCookie := f.sessionCookie(rec)
	if impersonatedCookie.Value == adminCookie.Value {
		t.Fatal("impersonation reused the admin's session token")
	}

	impersonated, err := f.svc.SessionFromRequest(signedInRequest(impersonatedCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest (impersonated): %v", err)
	}
	if impersonated == nil {
		t.Fatal("impersonated cookie resolved to no session")
	}
	if impersonated.UserID != targetID {
		t.Errorf("UserID = %q, want the target %q", impersonated.UserID, targetID)
	}
	if impersonated.ImpersonatedBy != adminID {
		t.Errorf("ImpersonatedBy = %q, want %q", impersonated.ImpersonatedBy, adminID)
	}

	// The admin's own session survives the impersonation.
	stillAdmin, err := f.svc.SessionFromRequest(signedInRequest(adminCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest (admin during impersonation): %v", err)
	}
	if stillAdmin == nil || stillAdmin.UserID != adminID {
		t.Fatalf("admin session lost during impersonation: %+v", stillAdmin)
	}

	stopRec := httptest.NewRecorder()
	if err := f.svc.StopImpersonating(f.ctx, stopRec, signedInRequest(impersonatedCookie), impersonated); err != nil {
		t.Fatalf("StopImpersonating: %v", err)
	}

	restored := f.sessionCookie(stopRec)
	if restored.Value != adminCookie.Value {
		t.Errorf("restored cookie = %q, want the admin token", restored.Value)
	}

	back, err := f.svc.SessionFromRequest(signedInRequest(restored))
	if err != nil {
		t.Fatalf("SessionFromRequest (restored): %v", err)
	}
	if back == nil || back.UserID != adminID {
		t.Fatalf("restored session is not the admin: %+v", back)
	}
	if back.ImpersonatedBy != "" {
		t.Errorf("restored session still marked impersonated by %q", back.ImpersonatedBy)
	}

	// The impersonated token is revoked, not merely un-cookied.
	revoked, err := f.svc.SessionFromRequest(signedInRequest(impersonatedCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest (revoked): %v", err)
	}
	if revoked != nil {
		t.Fatalf("impersonated session still valid after StopImpersonating: %+v", revoked)
	}
}

// The admin's session token must never be reachable from the impersonated
// session: metadata is served back to its own owner by Limen's ListSessions,
// so a token there is a privilege escalation. Only the marker belongs in
// metadata; the token lives in the server-only impersonation table.
func TestImpersonatedSessionMetadataHoldsNoAdminToken(t *testing.T) {
	f := newFixture(t, false)

	adminID, adminCookie := f.signIn("Sysadmin", "admin@example.com")
	targetID, _ := f.signIn("Target", "target@example.com")
	f.promote(adminID)

	adminSession, err := f.svc.SessionFromRequest(signedInRequest(adminCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}

	rec := httptest.NewRecorder()
	if err := f.svc.Impersonate(f.ctx, rec, signedInRequest(adminCookie), adminSession, targetID); err != nil {
		t.Fatalf("Impersonate: %v", err)
	}
	impersonated := f.sessionCookie(rec)

	var metadata string
	if err := f.rig.Pool.QueryRow(f.ctx,
		`SELECT COALESCE("metadata", '') FROM "sessions" WHERE "token" = $1`, impersonated.Value,
	).Scan(&metadata); err != nil {
		t.Fatalf("read impersonated session metadata: %v", err)
	}
	if strings.Contains(metadata, adminCookie.Value) {
		t.Fatalf("the admin's session token is readable from the impersonated session: %s", metadata)
	}
	if strings.Contains(metadata, "admin_token") {
		t.Fatalf("session metadata still carries an admin_token key: %s", metadata)
	}

	// It is in the server-only table instead.
	var stored string
	if err := f.rig.Pool.QueryRow(f.ctx,
		`SELECT "admin_token" FROM "impersonation" WHERE "impersonated_token" = $1`, impersonated.Value,
	).Scan(&stored); err != nil {
		t.Fatalf("read impersonation record: %v", err)
	}
	if stored != adminCookie.Value {
		t.Fatalf("impersonation record holds %q, want the admin token", stored)
	}
}

// Revoking either session takes the impersonation record with it, so no code
// path has to remember to tidy up.
func TestImpersonationRecordCascadesWithTheSession(t *testing.T) {
	f := newFixture(t, false)

	adminID, adminCookie := f.signIn("Sysadmin", "admin@example.com")
	targetID, _ := f.signIn("Target", "target@example.com")
	f.promote(adminID)

	adminSession, err := f.svc.SessionFromRequest(signedInRequest(adminCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	rec := httptest.NewRecorder()
	if err := f.svc.Impersonate(f.ctx, rec, signedInRequest(adminCookie), adminSession, targetID); err != nil {
		t.Fatalf("Impersonate: %v", err)
	}

	if err := f.svc.RevokeAllSessions(f.ctx, adminID); err != nil {
		t.Fatalf("RevokeAllSessions: %v", err)
	}

	var n int
	if err := f.rig.Pool.QueryRow(f.ctx, `SELECT COUNT(*)::int FROM "impersonation"`).Scan(&n); err != nil {
		t.Fatalf("count impersonation rows: %v", err)
	}
	if n != 0 {
		t.Fatalf("impersonation record survived revoking the admin's session (%d rows)", n)
	}
}

// If the admin's own session is gone, stopping must still end the
// impersonation rather than strand the operator as the target.
func TestStopImpersonatingIsTerminalWhenAdminSessionIsGone(t *testing.T) {
	f := newFixture(t, false)

	adminID, adminCookie := f.signIn("Sysadmin", "admin@example.com")
	targetID, _ := f.signIn("Target", "target@example.com")
	f.promote(adminID)

	adminSession, err := f.svc.SessionFromRequest(signedInRequest(adminCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	rec := httptest.NewRecorder()
	if err := f.svc.Impersonate(f.ctx, rec, signedInRequest(adminCookie), adminSession, targetID); err != nil {
		t.Fatalf("Impersonate: %v", err)
	}
	impersonatedCookie := f.sessionCookie(rec)
	impersonated, err := f.svc.SessionFromRequest(signedInRequest(impersonatedCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest (impersonated): %v", err)
	}

	// The admin's own session disappears mid-impersonation (signed out
	// elsewhere, expiry cleanup, another admin revoking them).
	if _, err := f.rig.Pool.Exec(f.ctx, `DELETE FROM "sessions" WHERE "token" = $1`, adminCookie.Value); err != nil {
		t.Fatalf("delete admin session: %v", err)
	}

	stopRec := httptest.NewRecorder()
	if err := f.svc.StopImpersonating(f.ctx, stopRec, signedInRequest(impersonatedCookie), impersonated); err == nil {
		t.Fatal("StopImpersonating should report that the admin session could not be restored")
	}

	// Terminal: the impersonated session is dead and the cookie cleared.
	after, err := f.svc.SessionFromRequest(signedInRequest(impersonatedCookie))
	if err != nil {
		t.Fatalf("SessionFromRequest after failed stop: %v", err)
	}
	if after != nil {
		t.Fatalf("operator is still signed in as the target: %+v", after)
	}
	cleared := false
	for _, c := range stopRec.Result().Cookies() {
		if c.Name == "limen_session" && c.Value == "" && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("the session cookie was not cleared on a failed stop")
	}
}

func TestImpersonateRequiresSystemAdmin(t *testing.T) {
	f := newFixture(t, false)

	_, cookie := f.signIn("Ordinary", "ordinary@example.com")
	targetID, _ := f.signIn("Target", "target@example.com")

	session, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}

	err = f.svc.Impersonate(f.ctx, httptest.NewRecorder(), signedInRequest(cookie), session, targetID)
	if err == nil {
		t.Fatal("a non-admin was allowed to impersonate")
	}
}

func TestStopImpersonatingOnOrdinarySession(t *testing.T) {
	f := newFixture(t, false)

	_, cookie := f.signIn("Ordinary", "ordinary@example.com")
	session, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}

	if err := f.svc.StopImpersonating(f.ctx, httptest.NewRecorder(), signedInRequest(cookie), session); err == nil {
		t.Fatal("StopImpersonating succeeded on a session that was not impersonating")
	}
}

// A user provisioned without a password (the invite-redeem path) exists and
// cannot sign in with the empty password.
func TestCreateUserWithoutPassword(t *testing.T) {
	f := newFixture(t, false)

	userID, err := f.svc.CreateUser(f.ctx, "Invited", "invited@example.com", "")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if userID == "" {
		t.Fatal("CreateUser returned an empty id")
	}

	rec := f.post(auth.BasePath+"/signin/credential", `{"credential":"invited@example.com","password":""}`)
	if rec.Code == http.StatusOK {
		t.Fatal("a passwordless account signed in with an empty password")
	}

	// SetPassword then makes the account usable — the account-recovery path.
	if err := f.svc.SetPassword(f.ctx, userID, signInPassword); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"credential": "invited@example.com", "password": signInPassword})
	rec = f.post(auth.BasePath+"/signin/credential", string(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("sign in after SetPassword: got %d, body %s", rec.Code, rec.Body.String())
	}
}

func TestRevokeAllSessions(t *testing.T) {
	f := newFixture(t, false)

	userID, cookie := f.signIn("Kari", "kari@example.com")

	if err := f.svc.RevokeAllSessions(f.ctx, userID); err != nil {
		t.Fatalf("RevokeAllSessions: %v", err)
	}

	session, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if session != nil {
		t.Fatalf("session survived RevokeAllSessions: %+v", session)
	}
}

// Sessions must not record the caller's address: the metadata Limen writes
// carries a SHA-256 of it instead.
func TestSessionMetadataStoresNoRawAddress(t *testing.T) {
	f := newFixture(t, false)

	_, cookie := f.signIn("Kari", "kari@example.com")

	var metadata string
	if err := f.rig.Pool.QueryRow(f.ctx,
		`SELECT COALESCE("metadata", '') FROM "sessions" WHERE "token" = $1`, cookie.Value,
	).Scan(&metadata); err != nil {
		t.Fatalf("read session metadata: %v", err)
	}

	// httptest.NewRequest uses 192.0.2.1:1234 as RemoteAddr.
	if strings.Contains(metadata, "192.0.2.1") {
		t.Fatalf("session metadata records the raw client address: %s", metadata)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(metadata), &decoded); err != nil {
		t.Fatalf("session metadata is not JSON: %v", err)
	}
	if ip, _ := decoded["ip_address"].(string); len(ip) != 64 {
		t.Fatalf("ip_address = %q, want a 64-char SHA-256 hex digest", ip)
	}
}

// membershipOf returns the family membership row for a user, failing when
// there is none.
func membershipOf(t *testing.T, f *fixture, familyID, userID string) gen.GetMembershipRow {
	t.Helper()
	row, err := f.rig.Q.GetMembership(f.ctx, gen.GetMembershipParams{
		OrganizationID: familyID,
		UserID:         userID,
	})
	if err != nil {
		t.Fatalf("GetMembership(%s, %s): %v", familyID, userID, err)
	}
	return row
}

func assertRoles(t *testing.T, f *fixture, familyID, userID string, want []string) {
	t.Helper()
	got := membershipOf(t, f, familyID, userID).Roles
	if len(got) != len(want) {
		t.Fatalf("roles = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("roles = %v, want %v", got, want)
		}
	}
}
