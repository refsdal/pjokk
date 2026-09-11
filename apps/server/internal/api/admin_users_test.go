package api_test

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// The operator console's user page (docs/superpowers/specs/
// 2026-09-11-admin-user-support-design.md §1–§2): detail, email change,
// system-admin revoke, and signing out one session.
// -----------------------------------------------------------------------

type supportWorld struct {
	a           *testrig.AppRig
	familyID    string
	adminCookie string
	adminID     string
	boID        string
	boCookie    string
}

// newSupportWorld is a family with a system admin and one member, Bo.
func newSupportWorld(t *testing.T) supportWorld {
	t.Helper()
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")
	bo := a.SignUp("Bo Berg", "bo@example.com")
	boCookie := a.AddMember(familyID, bo, auth.RoleMember, "bo@example.com")
	return supportWorld{a: a, familyID: familyID, adminCookie: cookie, adminID: adminID, boID: bo, boCookie: boCookie}
}

func (w supportWorld) detail(t *testing.T, userID string) *testrig.Result {
	t.Helper()
	return w.a.Do(http.MethodGet, "/api/admin/users/"+userID, w.adminCookie, nil)
}

func sessionsIn(res *testrig.Result) []map[string]any {
	var out []map[string]any
	list, _ := res.JSON["sessions"].([]any)
	for _, s := range list {
		m, _ := s.(map[string]any)
		out = append(out, m)
	}
	return out
}

// sessionIDOf is the id of the session behind a Cookie header value.
func sessionIDOf(t *testing.T, a *testrig.AppRig, cookie string) string {
	t.Helper()
	var id string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "sessions" WHERE "token" = $1`, tokenOf(cookie)).Scan(&id); err != nil {
		t.Fatalf("session id: %v", err)
	}
	return id
}

// auditCount and lastAudit read the trail straight from the table.
func auditCount(t *testing.T, a *testrig.AppRig, action string) int {
	t.Helper()
	var n int
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "admin_audit" WHERE "action" = $1`, action).Scan(&n); err != nil {
		t.Fatalf("count audit: %v", err)
	}
	return n
}

func lastAudit(t *testing.T, a *testrig.AppRig, action string) (adminID, target, detail string) {
	t.Helper()
	var d *string
	if err := a.Rig.Pool.QueryRow(context.Background(), `
		SELECT "admin_id", "target", "detail" FROM "admin_audit"
		WHERE "action" = $1 ORDER BY "created_at" DESC, "id" DESC LIMIT 1`, action).Scan(&adminID, &target, &d); err != nil {
		t.Fatalf("no %q audit row: %v", action, err)
	}
	if d != nil {
		detail = *d
	}
	return adminID, target, detail
}

func signedIn(a *testrig.AppRig, cookie string) bool {
	return a.Do(http.MethodGet, "/api/me", cookie, nil).Status == http.StatusOK
}

func TestAdminUserDetailShowsFamiliesSignInAndSessions(t *testing.T) {
	w := newSupportWorld(t)
	second := w.a.SignIn("bo@example.com")
	if _, err := w.a.Rig.Pool.Exec(context.Background(), `
		INSERT INTO "accounts" ("user_id", "provider", "provider_account_id", "access_token", "refresh_token")
		VALUES ($1, 'google', 'google-sub-1', 'secret-access-token', 'secret-refresh-token')`, w.boID); err != nil {
		t.Fatalf("link google: %v", err)
	}

	res := w.detail(t, w.boID)
	if res.Status != http.StatusOK {
		t.Fatalf("detail = %d %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Bo Berg" || res.JSON["email"] != "bo@example.com" || res.JSON["hasPassword"] != true {
		t.Errorf("header = %v, want Bo, his address and a password", res.JSON)
	}

	families, _ := res.JSON["families"].([]any)
	if len(families) != 1 {
		t.Fatalf("families = %v, want Hansen", families)
	}
	if f := families[0].(map[string]any); f["familyId"] != w.familyID || f["name"] != "Hansen" || f["role"] != "member" {
		t.Errorf("family = %v, want Hansen as a member", f)
	}

	providers, _ := res.JSON["providers"].([]any)
	if len(providers) != 1 {
		t.Fatalf("providers = %v, want google", providers)
	}
	if p := providers[0].(map[string]any); p["provider"] != "google" || p["linkedAt"] == nil {
		t.Errorf("provider = %v, want google with the time it was linked", p)
	}

	sessions := sessionsIn(res)
	if len(sessions) != 2 {
		t.Fatalf("sessions = %v, want Bo's two", sessions)
	}
	inHansen := false
	for _, s := range sessions {
		for _, field := range []string{"id", "createdAt", "lastActiveAt", "expiresAt"} {
			if s[field] == nil || s[field] == "" {
				t.Errorf("session %v has no %s", s, field)
			}
		}
		if s["familyName"] == "Hansen" {
			inHansen = true
		}
		if s["impersonatedByName"] != nil {
			t.Errorf("Bo's own session marked impersonated: %v", s)
		}
	}
	if !inHansen {
		t.Errorf("no session says it is in Hansen: %v", sessions)
	}

	// Metadata only: no credential or address ever leaves the server.
	raw := string(res.Raw)
	for _, secret := range []string{tokenOf(w.boCookie), tokenOf(second), "secret-access-token", "secret-refresh-token", "ip_address"} {
		if strings.Contains(raw, secret) {
			t.Errorf("detail leaks %q: %s", secret, raw)
		}
	}

	for _, id := range []string{db.TombstoneID, "no-such-user"} {
		if res := w.detail(t, id); res.Status != http.StatusNotFound {
			t.Errorf("detail(%s) = %d, want 404", id, res.Status)
		}
	}
}

func TestAdminUserDetailMarksAnImpersonatedSession(t *testing.T) {
	w := newSupportWorld(t)
	start := w.a.Do(http.MethodPost, "/api/admin/users/"+w.boID+"/impersonate", w.adminCookie, nil)
	if start.Status != http.StatusOK {
		t.Fatalf("impersonate = %d %s", start.Status, start.Raw)
	}

	marked := 0
	for _, s := range sessionsIn(w.detail(t, w.boID)) {
		if s["impersonatedByName"] == "Rig admin" {
			marked++
		}
	}
	if marked != 1 {
		t.Errorf("sessions marked impersonated by Rig admin = %d, want exactly the one", marked)
	}
}

func TestAdminChangeEmail(t *testing.T) {
	w := newSupportWorld(t)
	path := "/api/admin/users/" + w.boID + "/email"

	res := w.a.Do(http.MethodPost, path, w.adminCookie, map[string]any{"email": "  Bo.New@Example.com "})
	if res.Status != http.StatusOK || res.JSON["email"] != "bo.new@example.com" {
		t.Fatalf("change = %d %s, want 200 with the normalised address", res.Status, res.Raw)
	}
	if admin, target, detail := lastAudit(t, w.a, "user.email.change"); admin != w.adminID || target != w.boID || detail != "bo@example.com → bo.new@example.com" {
		t.Errorf("audit = %s %s %q, want the admin, Bo, and old → new", admin, target, detail)
	}
	if !signedIn(w.a, w.boCookie) {
		t.Error("changing the address signed Bo out")
	}
	w.a.SignIn("bo.new@example.com") // fails the test if password sign-in does not work

	if res := w.a.Do(http.MethodPost, path, w.adminCookie, map[string]any{"email": "BO.NEW@example.com"}); res.Status != http.StatusBadRequest || res.JSON["code"] != "UNCHANGED" {
		t.Errorf("unchanged = %d %v, want 400 UNCHANGED", res.Status, res.JSON)
	}
	if res := w.a.Do(http.MethodPost, path, w.adminCookie, map[string]any{"email": "sysadmin@example.com"}); res.Status != http.StatusConflict || res.JSON["code"] != "EMAIL_TAKEN" {
		t.Errorf("taken = %d %v, want 409 EMAIL_TAKEN", res.Status, res.JSON)
	}
	if res := w.a.Do(http.MethodPost, path, w.adminCookie, map[string]any{"email": "not-an-address"}); res.Status != http.StatusBadRequest {
		t.Errorf("malformed = %d, want 400", res.Status)
	}
	if n := auditCount(t, w.a, "user.email.change"); n != 1 {
		t.Errorf("user.email.change rows = %d, want only the one change that happened", n)
	}
	if res := w.a.Do(http.MethodPost, "/api/admin/users/"+db.TombstoneID+"/email", w.adminCookie, map[string]any{"email": "ghost@example.com"}); res.Status != http.StatusNotFound {
		t.Errorf("tombstone = %d, want 404", res.Status)
	}
}

// secondOperator is another system admin, signed in.
func (w supportWorld) secondOperator(t *testing.T) (id, cookie string) {
	t.Helper()
	id = w.a.SignUp("Ola Operator", "ola@example.com")
	makeSysadmin(t, w.a, id)
	return id, w.a.SignIn("ola@example.com")
}

func TestAdminRevokeSystemAdmin(t *testing.T) {
	w := newSupportWorld(t)
	olaID, olaCookie := w.secondOperator(t)

	if res := w.a.Do(http.MethodDelete, "/api/admin/users/"+w.adminID+"/role", w.adminCookie, nil); res.Status != http.StatusBadRequest || res.JSON["code"] != "REFUSED" {
		t.Errorf("revoke yourself = %d %v, want 400 REFUSED", res.Status, res.JSON)
	}
	if res := w.a.Do(http.MethodDelete, "/api/admin/users/"+w.boID+"/role", w.adminCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("revoke a non-admin = %d, want 404", res.Status)
	}

	// Ola is impersonating Bo when the role goes.
	start := w.a.Do(http.MethodPost, "/api/admin/users/"+w.boID+"/impersonate", olaCookie, nil)
	if start.Status != http.StatusOK {
		t.Fatalf("Ola impersonates Bo = %d %s", start.Status, start.Raw)
	}
	impersonated := sessionCookieFrom(t, start)

	if res := w.a.Do(http.MethodDelete, "/api/admin/users/"+olaID+"/role", w.adminCookie, nil); res.Status != http.StatusNoContent {
		t.Fatalf("revoke Ola = %d %s", res.Status, res.Raw)
	}
	if res := w.a.Do(http.MethodGet, "/api/admin/stats", olaCookie, nil); res.Status != http.StatusForbidden {
		t.Errorf("Ola's next console request = %d, want 403 (effective at once)", res.Status)
	}
	if signedIn(w.a, impersonated) {
		t.Error("Ola kept acting as Bo after losing the role")
	}
	if admin, target, detail := lastAudit(t, w.a, "user.role.revoke"); admin != w.adminID || target != olaID || detail != "ola@example.com" {
		t.Errorf("audit = %s %s %q, want the admin revoking Ola", admin, target, detail)
	}
}

// Two operators revoking each other at the same moment must not leave the
// console with nobody able to run it: the revoke locks the active admins
// before it counts them.
func TestTwoOperatorsRevokingEachOtherLeaveOneStanding(t *testing.T) {
	w := newSupportWorld(t)
	olaID, olaCookie := w.secondOperator(t)

	var wg sync.WaitGroup
	statuses := make([]int, 2)
	start := make(chan struct{})
	for i, req := range []struct{ target, cookie string }{{olaID, w.adminCookie}, {w.adminID, olaCookie}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			statuses[i] = w.a.Do(http.MethodDelete, "/api/admin/users/"+req.target+"/role", req.cookie, nil).Status
		}()
	}
	close(start)
	wg.Wait()

	var admins int
	if err := w.a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "users" WHERE "role" = 'admin'`).Scan(&admins); err != nil {
		t.Fatalf("count admins: %v", err)
	}
	if admins != 1 {
		t.Errorf("system admins left = %d (statuses %v), want exactly one", admins, statuses)
	}
	if statuses[0] != http.StatusNoContent && statuses[1] != http.StatusNoContent {
		t.Errorf("statuses = %v, want one revoke to succeed", statuses)
	}
}

func TestAdminSignsOutOneSession(t *testing.T) {
	w := newSupportWorld(t)
	second := w.a.SignIn("bo@example.com")

	res := w.a.Do(http.MethodDelete, "/api/admin/users/"+w.boID+"/sessions/"+sessionIDOf(t, w.a, second), w.adminCookie, nil)
	if res.Status != http.StatusNoContent {
		t.Fatalf("sign out = %d %s", res.Status, res.Raw)
	}
	if signedIn(w.a, second) {
		t.Error("the signed-out session still works")
	}
	if !signedIn(w.a, w.boCookie) {
		t.Error("signing out one session signed Bo out everywhere")
	}
	if admin, target, _ := lastAudit(t, w.a, "user.session.revoke"); admin != w.adminID || target != w.boID {
		t.Errorf("audit = %s %s, want the admin signing out Bo's session", admin, target)
	}

	// The admin's own session, addressed under Bo, is not Bo's.
	if res := w.a.Do(http.MethodDelete, "/api/admin/users/"+w.boID+"/sessions/"+sessionIDOf(t, w.a, w.adminCookie), w.adminCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("someone else's session = %d, want 404", res.Status)
	}
	if !signedIn(w.a, w.adminCookie) {
		t.Error("the admin's session was revoked through Bo")
	}
	if res := w.a.Do(http.MethodDelete, "/api/admin/users/no-such-user/sessions/x", w.adminCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("unknown user = %d, want 404", res.Status)
	}
}

// Signing out the ONE session an operator is impersonating from ends the
// impersonation too (#93). Revoking that session cascades its
// `impersonation` row away, and the row is the only thing the sweep can
// find the impersonated session by, so the revoke has to sweep first.
func TestSigningOutAnOperatorsSessionEndsTheirImpersonation(t *testing.T) {
	w := newSupportWorld(t)
	olaID, olaCookie := w.secondOperator(t)

	start := w.a.Do(http.MethodPost, "/api/admin/users/"+w.boID+"/impersonate", olaCookie, nil)
	if start.Status != http.StatusOK {
		t.Fatalf("Ola impersonates Bo = %d %s", start.Status, start.Raw)
	}
	impersonated := sessionCookieFrom(t, start)

	res := w.a.Do(http.MethodDelete, "/api/admin/users/"+olaID+"/sessions/"+sessionIDOf(t, w.a, olaCookie), w.adminCookie, nil)
	if res.Status != http.StatusNoContent {
		t.Fatalf("sign out Ola's session = %d %s", res.Status, res.Raw)
	}

	// Revoked by the sign-out itself, before anything presents the cookie:
	// the sweep, not resolveSession's backstop, ended it.
	assertCount(t, w.a,
		`SELECT COUNT(*)::int FROM "sessions" WHERE "token" = $1`, 0, tokenOf(impersonated))
	if signedIn(w.a, impersonated) {
		t.Error("Ola kept acting as Bo after the session she impersonated from was signed out")
	}
	if !signedIn(w.a, w.boCookie) {
		t.Error("Bo's own session was signed out along with the impersonation")
	}
}
