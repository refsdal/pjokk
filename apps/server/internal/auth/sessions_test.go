package auth_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
)

// The operator console's user page (docs/superpowers/specs/
// 2026-09-11-admin-user-support-design.md §3): listing and revoking one
// person's sessions, changing their login address, and recording activity.

const androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"

// signInAgain signs an existing account in once more, from userAgent, and
// returns the new session's cookie — a second device.
func (f *fixture) signInAgain(email, userAgent string) *http.Cookie {
	f.tabs.Helper()
	body, _ := json.Marshal(map[string]string{"credential": email, "password": signInPassword})
	req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/signin/credential", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		f.tabs.Fatalf("sign in %s again: %d %s", email, rec.Code, rec.Body.String())
	}
	return f.sessionCookie(rec)
}

// sessionID is the id of the session behind cookie (its value is the token).
func (f *fixture) sessionID(cookie *http.Cookie) string {
	f.tabs.Helper()
	var id string
	if err := f.rig.Pool.QueryRow(f.ctx, `SELECT "id" FROM "sessions" WHERE "token" = $1`, cookie.Value).Scan(&id); err != nil {
		f.tabs.Fatalf("session id: %v", err)
	}
	return id
}

func (f *fixture) resolves(cookie *http.Cookie) bool {
	f.tabs.Helper()
	s, err := f.svc.SessionFromRequest(signedInRequest(cookie))
	if err != nil {
		f.tabs.Fatalf("SessionFromRequest: %v", err)
	}
	return s != nil
}

func TestUserSessionsListsEachDeviceWithoutItsToken(t *testing.T) {
	f := newFixture(t, false)
	userID, first := f.signIn("Anne", "anne@example.com")
	second := f.signInAgain("anne@example.com", androidChrome)

	sessions, err := f.svc.UserSessions(f.ctx, userID)
	if err != nil {
		t.Fatalf("UserSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("sessions = %+v, want two", sessions)
	}
	byID := map[string]auth.SessionInfo{}
	for _, s := range sessions {
		byID[s.ID] = s
		if s.CreatedAt.IsZero() || s.ExpiresAt.IsZero() || s.LastActiveAt.IsZero() {
			t.Errorf("session %s has an unset time: %+v", s.ID, s)
		}
		if s.ImpersonatedBy != "" {
			t.Errorf("session %s marked impersonated by %q", s.ID, s.ImpersonatedBy)
		}
	}
	if got := byID[f.sessionID(second)].UserAgent; got != androidChrome {
		t.Errorf("the Android session's user agent = %q, want %q", got, androidChrome)
	}
	if _, ok := byID[f.sessionID(first)]; !ok {
		t.Errorf("the first session is missing from %+v", sessions)
	}

	// Nothing in the listing is a credential.
	dump := fmt.Sprintf("%+v", sessions)
	for _, c := range []*http.Cookie{first, second} {
		if strings.Contains(dump, c.Value) {
			t.Errorf("UserSessions exposed a session token: %s", dump)
		}
	}
}

func TestRevokeSessionSignsOutOnlyThatOne(t *testing.T) {
	f := newFixture(t, false)
	userID, first := f.signIn("Anne", "anne@example.com")
	second := f.signInAgain("anne@example.com", androidChrome)
	otherID, other := f.signIn("Bo", "bo@example.com")

	if err := f.svc.RevokeSession(f.ctx, userID, f.sessionID(second)); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	if f.resolves(second) {
		t.Error("the revoked session still resolves")
	}
	if !f.resolves(first) {
		t.Error("revoking one session signed out the other")
	}

	// Another person's session, addressed under this user, is not found —
	// and survives.
	if err := f.svc.RevokeSession(f.ctx, userID, f.sessionID(other)); !errors.Is(err, auth.ErrSessionNotFound) {
		t.Errorf("RevokeSession(someone else's) = %v, want ErrSessionNotFound", err)
	}
	if !f.resolves(other) {
		t.Errorf("user %s's session was revoked through another user", otherID)
	}
}

func TestChangeEmailKeepsSignInWorking(t *testing.T) {
	f := newFixture(t, false)
	userID, cookie := f.signIn("Anne", "anne@example.com")
	f.signIn("Bo", "bo@example.com")
	if _, err := f.rig.Pool.Exec(f.ctx, `UPDATE "users" SET "email_verified_at" = now() WHERE "id" = $1`, userID); err != nil {
		t.Fatalf("mark verified: %v", err)
	}

	if err := f.svc.ChangeEmail(f.ctx, userID, "  Anne.New@Example.COM "); err != nil {
		t.Fatalf("ChangeEmail: %v", err)
	}
	var email string
	var verified *time.Time
	if err := f.rig.Pool.QueryRow(f.ctx, `SELECT "email", "email_verified_at" FROM "users" WHERE "id" = $1`, userID).Scan(&email, &verified); err != nil {
		t.Fatalf("read user: %v", err)
	}
	if want := auth.NormalizeEmail("  Anne.New@Example.COM "); email != want {
		t.Errorf("email = %q, want the normalised %q", email, want)
	}
	if verified != nil {
		t.Errorf("email_verified_at = %v, want cleared: nobody has verified the new address", verified)
	}

	// Existing sessions stay; password sign-in uses the new address.
	if !f.resolves(cookie) {
		t.Error("changing the address signed the person out")
	}
	f.signInAgain(email, "")

	// Someone else's address is refused, whatever its case.
	if err := f.svc.ChangeEmail(f.ctx, userID, "BO@example.com"); !errors.Is(err, auth.ErrEmailTaken) {
		t.Errorf("ChangeEmail(taken) = %v, want ErrEmailTaken", err)
	}
}

func TestSessionActivityIsRecorded(t *testing.T) {
	f := newFixture(t, false)
	_, cookie := f.signIn("Anne", "anne@example.com")
	if _, err := f.rig.Pool.Exec(f.ctx,
		`UPDATE "sessions" SET "last_access" = now() - interval '10 minutes' WHERE "token" = $1`, cookie.Value); err != nil {
		t.Fatalf("age the session: %v", err)
	}

	if !f.resolves(cookie) {
		t.Fatal("the session did not resolve")
	}
	var lastAccess time.Time
	if err := f.rig.Pool.QueryRow(f.ctx, `SELECT "last_access" FROM "sessions" WHERE "token" = $1`, cookie.Value).Scan(&lastAccess); err != nil {
		t.Fatalf("read last_access: %v", err)
	}
	if time.Since(lastAccess) > time.Minute {
		t.Errorf("last_access = %v, want it moved to now by the request", lastAccess)
	}
}
