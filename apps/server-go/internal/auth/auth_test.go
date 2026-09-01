package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

	if _, err := f.rig.Pool.Exec(f.ctx, `UPDATE "users" SET "banned" = true WHERE "id" = $1`, userID); err != nil {
		t.Fatalf("ban user: %v", err)
	}

	session, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		t.Fatalf("SessionFromRequest: %v", err)
	}
	if session != nil {
		t.Fatalf("banned user must read as signed out, got %+v", session)
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

	if _, err := f.rig.Pool.Exec(f.ctx, `UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, adminID); err != nil {
		t.Fatalf("promote to system admin: %v", err)
	}

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
