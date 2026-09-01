package middleware_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

const testSecret = "pjokk-test-auth-secret-value-0123456789"
const signInPassword = "Testpass123"

// fixture is one middleware test's world: a real Postgres, a real auth
// service against it, and the middleware Deps built from both. Sessions are
// created through the actual sign-in route, so what the middleware resolves
// is what a browser would present.
type fixture struct {
	t    *testing.T
	rig  *testrig.Rig
	svc  auth.Service
	deps middleware.Deps
	mux  *http.ServeMux
	ctx  context.Context
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	rig := testrig.Setup(t)
	svc, err := auth.New(auth.Config{
		AppURL:     "http://localhost:3000",
		Secret:     testSecret,
		OpenSignup: false,
		Pool:       rig.Pool,
	})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle(auth.BasePath+"/", svc.Handler())

	return &fixture{
		t:   t,
		rig: rig,
		svc: svc,
		deps: middleware.Deps{
			Auth:      svc,
			Q:         rig.Q,
			RateLimit: ratelimit.NewPostgres(rig.Q),
		},
		mux: mux,
		ctx: context.Background(),
	}
}

// signIn creates a user and signs them in through the real HTTP route.
func (f *fixture) signIn(name, email string) (userID string, cookie *http.Cookie) {
	f.t.Helper()

	userID, err := f.svc.CreateUser(f.ctx, name, email, signInPassword)
	if err != nil {
		f.t.Fatalf("CreateUser: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"credential": email, "password": signInPassword})
	req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/signin/credential", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		f.t.Fatalf("sign in: %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == "limen_session" && c.Value != "" {
			return userID, c
		}
	}
	f.t.Fatalf("no session cookie after sign-in: %s", rec.Body.String())
	return "", nil
}

// family creates a family owned by userID and points their session at it,
// the way the SPA's family switcher does.
func (f *fixture) family(userID, sessionToken, name string) string {
	f.t.Helper()

	familyID, err := f.svc.CreateFamily(f.ctx, userID, name)
	if err != nil {
		f.t.Fatalf("CreateFamily: %v", err)
	}
	if err := f.svc.SetActiveFamily(f.ctx, sessionToken, familyID); err != nil {
		f.t.Fatalf("SetActiveFamily: %v", err)
	}
	return familyID
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.rig.Pool.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatalf("exec %q: %v", sql, err)
	}
}

// apiKeyOpts describes a key to insert. Zero values mean "an ordinary,
// live, read-write key".
type apiKeyOpts struct {
	readOnly  bool
	expiresAt *time.Time
	revoked   bool
	lastUsed  *time.Time
}

// createAPIKey inserts a key row and returns the plaintext token. The token
// is what a client sends; only its SHA-256 is stored.
func (f *fixture) createAPIKey(familyID, createdBy string, opts apiKeyOpts) string {
	f.t.Helper()

	token := fmt.Sprintf("pjk_%s", strings.ReplaceAll(familyID, "-", ""))
	sum := sha256.Sum256([]byte(token))
	var revokedAt *time.Time
	if opts.revoked {
		now := time.Now()
		revokedAt = &now
	}
	f.exec(`
		INSERT INTO "api_key"
			("family_id", "name", "key_hash", "prefix", "created_by",
			 "read_only", "expires_at", "revoked_at", "last_used_at")
		VALUES ($1, 'test key', $2, 'pjk_', $3, $4, $5, $6, $7)`,
		familyID, hex.EncodeToString(sum[:]), createdBy,
		opts.readOnly, opts.expiresAt, revokedAt, opts.lastUsed,
	)
	return token
}

// probe is the terminal handler under test: it records what the chain put in
// the request context and answers 200.
type probe struct {
	called  bool
	family  middleware.FamilyCtx
	session *auth.Session
}

func (p *probe) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.called = true
		p.family = middleware.Family(r)
		p.session = middleware.SessionFrom(r)
		w.WriteHeader(http.StatusOK)
	})
}

// envelope decodes the {error, code} body.
func envelope(t *testing.T, rec *httptest.ResponseRecorder) (message, code string) {
	t.Helper()
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error envelope from %q: %v", rec.Body.String(), err)
	}
	return body.Error, body.Code
}

// assertRejected checks status + code together: a middleware that returns the
// right status with the wrong code is a client-visible break.
func assertRejected(t *testing.T, rec *httptest.ResponseRecorder, p *probe, wantStatus int, wantCode string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, wantStatus, rec.Body.String())
	}
	_, code := envelope(t, rec)
	if code != wantCode {
		t.Errorf("code = %q, want %q", code, wantCode)
	}
	if p != nil && p.called {
		t.Error("the request reached the handler despite being rejected")
	}
}

// -------------------------------------------------------------------------
// RequireFamily — REF §A5 item 2
// -------------------------------------------------------------------------

func TestRequireFamilyRejectsAnonymousRequests(t *testing.T) {
	f := newFixture(t)
	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/summary", nil))

	assertRejected(t, rec, p, http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestRequireFamilyRejectsASessionWithoutAnActiveFamily(t *testing.T) {
	f := newFixture(t)
	_, cookie := f.signIn("No Family", "nofamily@example.com")
	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusForbidden, "NO_FAMILY")
}

// An active_organization_id is not proof of membership: the membership row is.
func TestRequireFamilyRejectsWhenTheMembershipRowIsGone(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Ex Member", "ex@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	// Delete the membership WITHOUT clearing the session's active family —
	// exactly the state a direct DELETE, a race, or a bug would leave.
	f.exec(`DELETE FROM "organization_member_roles" WHERE "organization_id" = $1`, familyID)
	f.exec(`DELETE FROM "organization_members" WHERE "organization_id" = $1`, familyID)

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusForbidden, "NOT_MEMBER")
}

func TestRequireFamilyPopulatesTheFamilyContext(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Kari Nordmann", "kari@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	switch {
	case p.family.FamilyID != familyID:
		t.Errorf("FamilyID = %q, want %q", p.family.FamilyID, familyID)
	case p.family.UserID != userID:
		t.Errorf("UserID = %q, want %q", p.family.UserID, userID)
	case p.family.UserName != "Kari Nordmann":
		t.Errorf("UserName = %q, want Kari Nordmann", p.family.UserName)
	case p.family.MemberRole != auth.RoleAdmin:
		t.Errorf("MemberRole = %q, want %q (the family's creator is a parent)", p.family.MemberRole, auth.RoleAdmin)
	case p.family.Plan != "free":
		t.Errorf("Plan = %q, want free", p.family.Plan)
	case p.family.IsAPIKey:
		t.Error("IsAPIKey = true for a cookie session")
	case p.family.ImpersonatedBy != "":
		t.Errorf("ImpersonatedBy = %q, want empty", p.family.ImpersonatedBy)
	}
}

// Pjokk writes exactly one role per membership, but the schema permits more
// (Limen's shape: one row per role held). If that ever happens the resolved
// role must be the most privileged one — sorting by the role NAME would rank
// "member" ahead of "owner" and silently demote the caller.
func TestRequireFamilyResolvesTheMostPrivilegedRole(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Two Roles", "tworoles@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	f.exec(`DELETE FROM "organization_member_roles" WHERE "organization_id" = $1`, familyID)
	f.exec(`
		INSERT INTO "organization_member_roles" ("member_id", "organization_id", "role")
		SELECT om."id", om."organization_id", r."role"
		FROM "organization_members" om, (VALUES ('member'), ('owner')) AS r("role")
		WHERE om."organization_id" = $1`, familyID)

	p := &probe{}
	handler := middleware.Session(f.deps)(
		middleware.RequireFamily(f.deps)(middleware.RequireAdmin()(p.handler())))

	req := httptest.NewRequest(http.MethodGet, "/api/invites", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s — an owner was demoted to member", rec.Code, rec.Body.String())
	}
	if p.family.MemberRole != "owner" {
		t.Errorf("MemberRole = %q, want owner", p.family.MemberRole)
	}
}

// A membership row with no role row still IS a membership. RequireFamily's
// job is tenancy, not authorization: the caller gets in with an empty role,
// which is member-level access and fails RequireAdmin. The alternative — 403
// NOT_MEMBER — would lock a family out of its own data over a missing role
// row, which is the wrong direction to fail.
func TestRequireFamilyAdmitsARolelessMembership(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Roleless", "roleless@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	f.exec(`DELETE FROM "organization_member_roles" WHERE "organization_id" = $1`, familyID)

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if p.family.FamilyID != familyID {
		t.Errorf("FamilyID = %q, want %q", p.family.FamilyID, familyID)
	}
	if p.family.MemberRole != "" {
		t.Errorf("MemberRole = %q, want empty", p.family.MemberRole)
	}

	// ...and that empty role is refused the admin surface.
	adminProbe := &probe{}
	adminHandler := middleware.Session(f.deps)(
		middleware.RequireFamily(f.deps)(middleware.RequireAdmin()(adminProbe.handler())))
	adminReq := httptest.NewRequest(http.MethodGet, "/api/invites", nil)
	adminReq.AddCookie(cookie)
	adminRec := httptest.NewRecorder()
	adminHandler.ServeHTTP(adminRec, adminReq)
	assertRejected(t, adminRec, adminProbe, http.StatusForbidden, "FORBIDDEN")
}

// -------------------------------------------------------------------------
// Impersonated writes — REF §A5 item 2, second half
// -------------------------------------------------------------------------

// impersonate signs an admin in, has them impersonate target, and returns the
// impersonated session cookie.
func (f *fixture) impersonate(targetUserID string) *http.Cookie {
	f.t.Helper()

	adminID, adminCookie := f.signIn("Sys Admin", "sysadmin@example.com")
	f.exec(`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, adminID)

	adminReq := httptest.NewRequest(http.MethodGet, "/api/admin", nil)
	adminReq.AddCookie(adminCookie)
	adminSession, err := f.svc.SessionFromRequest(adminReq)
	if err != nil || adminSession == nil {
		f.t.Fatalf("resolve admin session: %v", err)
	}

	rec := httptest.NewRecorder()
	if err := f.svc.Impersonate(f.ctx, rec, adminReq, adminSession, targetUserID); err != nil {
		f.t.Fatalf("Impersonate: %v", err)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == "limen_session" && c.Value != "" && c.Value != adminCookie.Value {
			return c
		}
	}
	f.t.Fatal("Impersonate set no session cookie")
	return nil
}

func (f *fixture) auditRows() []struct{ AdminID, Action, Target, Detail string } {
	f.t.Helper()
	rows, err := f.rig.Pool.Query(f.ctx,
		`SELECT "admin_id", "action", "target", COALESCE("detail", '') FROM "admin_audit" ORDER BY "created_at"`)
	if err != nil {
		f.t.Fatalf("read audit trail: %v", err)
	}
	defer rows.Close()
	var out []struct{ AdminID, Action, Target, Detail string }
	for rows.Next() {
		var row struct{ AdminID, Action, Target, Detail string }
		if err := rows.Scan(&row.AdminID, &row.Action, &row.Target, &row.Detail); err != nil {
			f.t.Fatalf("scan audit row: %v", err)
		}
		out = append(out, row)
	}
	return out
}

func TestImpersonatedWriteIsAudited(t *testing.T) {
	f := newFixture(t)
	targetID, targetCookie := f.signIn("Target Parent", "target@example.com")
	familyID := f.family(targetID, targetCookie.Value, "Hansen")
	impersonated := f.impersonate(targetID)
	// Impersonation mints a fresh session, which starts with no active
	// family — the admin lands in the switcher exactly as the user would.
	if err := f.svc.SetActiveFamily(f.ctx, impersonated.Value, familyID); err != nil {
		t.Fatalf("SetActiveFamily on the impersonated session: %v", err)
	}

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	req := httptest.NewRequest(http.MethodPost, "/api/feeds", nil)
	req.AddCookie(impersonated)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if p.family.ImpersonatedBy == "" {
		t.Error("FamilyCtx.ImpersonatedBy is empty for an impersonated session")
	}
	rows := f.auditRows()
	if len(rows) != 1 {
		t.Fatalf("audit rows = %d, want 1: %+v", len(rows), rows)
	}
	switch {
	case rows[0].Action != "impersonated.write":
		t.Errorf("action = %q, want impersonated.write", rows[0].Action)
	case rows[0].Target != targetID:
		t.Errorf("target = %q, want the impersonated user %q", rows[0].Target, targetID)
	case rows[0].AdminID != p.family.ImpersonatedBy:
		t.Errorf("admin_id = %q, want the impersonating admin %q", rows[0].AdminID, p.family.ImpersonatedBy)
	case rows[0].Detail != "POST /api/feeds":
		t.Errorf("detail = %q, want \"POST /api/feeds\"", rows[0].Detail)
	}
}

func TestImpersonatedReadIsNotAudited(t *testing.T) {
	f := newFixture(t)
	targetID, targetCookie := f.signIn("Target Parent", "target@example.com")
	familyID := f.family(targetID, targetCookie.Value, "Hansen")
	impersonated := f.impersonate(targetID)
	// Impersonation mints a fresh session, which starts with no active
	// family — the admin lands in the switcher exactly as the user would.
	if err := f.svc.SetActiveFamily(f.ctx, impersonated.Value, familyID); err != nil {
		t.Fatalf("SetActiveFamily on the impersonated session: %v", err)
	}

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(p.handler()))

	req := httptest.NewRequest(http.MethodGet, "/api/timeline", nil)
	req.AddCookie(impersonated)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if rows := f.auditRows(); len(rows) != 0 {
		t.Errorf("a read wrote %d audit rows, want 0: %+v", len(rows), rows)
	}
}

// -------------------------------------------------------------------------
// RequireAdmin — REF §A5 item 3
// -------------------------------------------------------------------------

func TestRequireAdminAllowsAFamilyAdmin(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	f.family(userID, cookie.Value, "Hansen")

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(middleware.RequireAdmin()(p.handler())))

	req := httptest.NewRequest(http.MethodGet, "/api/invites", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}

func TestRequireAdminRejectsAPlainMember(t *testing.T) {
	f := newFixture(t)
	ownerID, ownerCookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(ownerID, ownerCookie.Value, "Hansen")

	memberID, memberCookie := f.signIn("Grandma", "grandma@example.com")
	if err := f.svc.AddMember(f.ctx, familyID, memberID, auth.RoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := f.svc.SetActiveFamily(f.ctx, memberCookie.Value, familyID); err != nil {
		t.Fatalf("SetActiveFamily: %v", err)
	}

	p := &probe{}
	handler := middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(middleware.RequireAdmin()(p.handler())))

	req := httptest.NewRequest(http.MethodGet, "/api/invites", nil)
	req.AddCookie(memberCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusForbidden, "FORBIDDEN")
}

func TestRequireAdminRejectsAPIKeys(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{})

	p := &probe{}
	handler := middleware.APIKeyAuth(f.deps)(
		middleware.Session(f.deps)(
			middleware.RequireFamily(f.deps)(
				middleware.RequireAdmin()(p.handler()))))

	req := httptest.NewRequest(http.MethodGet, "/api/keys", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusForbidden, "FORBIDDEN")
}

// -------------------------------------------------------------------------
// APIKeyAuth — REF §A5 item 5
// -------------------------------------------------------------------------

// apiKeyChain is the shipped order: keys resolve first, the session
// middleware then skips its own lookup, and the tenancy gate treats both the
// same.
func (f *fixture) apiKeyChain(p *probe) http.Handler {
	return middleware.APIKeyAuth(f.deps)(
		middleware.Session(f.deps)(
			middleware.RequireFamily(f.deps)(p.handler())))
}

func TestAPIKeyAuthAcceptsALiveKey(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{})

	p := &probe{}
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	switch {
	case !p.family.IsAPIKey:
		t.Error("IsAPIKey = false for a pjk_ bearer request")
	case p.family.FamilyID != familyID:
		t.Errorf("FamilyID = %q, want the key's family %q", p.family.FamilyID, familyID)
	case p.family.UserID != userID:
		t.Errorf("UserID = %q, want the key's creator %q (attribution)", p.family.UserID, userID)
	case p.family.MemberRole != auth.RoleAdmin:
		t.Errorf("MemberRole = %q, want the creator's role", p.family.MemberRole)
	}
}

func TestAPIKeyAuthRejectsAnUnknownKey(t *testing.T) {
	f := newFixture(t)
	p := &probe{}

	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer pjk_nosuchkey")
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusUnauthorized, "INVALID_KEY")
}

// A revoked key must be indistinguishable from one that never existed.
func TestAPIKeyAuthRejectsARevokedKey(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{revoked: true})

	p := &probe{}
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusUnauthorized, "INVALID_KEY")
}

// A ban is enforced by absence — banning revokes every session the user
// holds (Task 21's /api/admin/users/{id}/ban) — but an API key is a second,
// longer-lived credential that no session revocation touches. Filtering it
// at the authentication join is the only place that closes for every route
// at once, since a key authenticates AS its creator.
func TestAPIKeyAuthRejectsAKeyWhoseCreatorIsBanned(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{})

	// The key works before the ban.
	before := &probe{}
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	f.apiKeyChain(before).ServeHTTP(httptest.NewRecorder(), req)
	if !before.called {
		t.Fatal("the key was rejected before the ban")
	}

	f.exec(`UPDATE "users" SET "banned" = true WHERE "id" = $1`, userID)

	after := &probe{}
	banned := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	banned.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.apiKeyChain(after).ServeHTTP(rec, banned)

	// Indistinguishable from a key that never existed, same as a revoked one.
	assertRejected(t, rec, after, http.StatusUnauthorized, "INVALID_KEY")
}

func TestAPIKeyAuthRejectsAnExpiredKey(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	past := time.Now().Add(-time.Hour)
	token := f.createAPIKey(familyID, userID, apiKeyOpts{expiresAt: &past})

	p := &probe{}
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusUnauthorized, "KEY_EXPIRED")
}

func TestAPIKeyAuthRejectsWritesFromAReadOnlyKey(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{readOnly: true})

	p := &probe{}
	req := httptest.NewRequest(http.MethodPatch, "/api/feeds/1", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	assertRejected(t, rec, p, http.StatusForbidden, "READ_ONLY_KEY")
}

func TestAPIKeyAuthAllowsReadsFromAReadOnlyKey(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{readOnly: true})

	p := &probe{}
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("a read-only key was refused a GET: %d %s", rec.Code, rec.Body.String())
	}
}

// Only pjk_ bearers are key auth. Anything else is Limen's business (the
// bearer plugin accepts session tokens the same way) and must fall through
// to the session middleware untouched.
func TestAPIKeyAuthIgnoresOtherBearerTokens(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")

	p := &probe{}
	req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
	req.Header.Set("Authorization", "Bearer "+cookie.Value)
	rec := httptest.NewRecorder()
	f.apiKeyChain(p).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("a session bearer token was rejected: %d %s", rec.Code, rec.Body.String())
	}
	if p.family.IsAPIKey {
		t.Error("IsAPIKey = true for a session bearer token")
	}
	if p.family.FamilyID != familyID {
		t.Errorf("FamilyID = %q, want %q", p.family.FamilyID, familyID)
	}
}

// last_used_at is coarse on purpose: one write per five minutes per key, not
// one per request.
func TestAPIKeyAuthStampsLastUsedAtMostEveryFiveMinutes(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{})

	call := func() {
		p := &probe{}
		req := httptest.NewRequest(http.MethodGet, "/api/summary", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		f.apiKeyChain(p).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			f.t.Fatalf("key request failed: %d %s", rec.Code, rec.Body.String())
		}
	}
	lastUsed := func() *time.Time {
		var at *time.Time
		if err := f.rig.Pool.QueryRow(f.ctx, `SELECT "last_used_at" FROM "api_key"`).Scan(&at); err != nil {
			t.Fatalf("read last_used_at: %v", err)
		}
		return at
	}

	// A never-used key is stamped on first use.
	call()
	first := lastUsed()
	if first == nil {
		t.Fatal("last_used_at is still NULL after the first request")
	}

	// A second request inside the window leaves it alone.
	call()
	if second := lastUsed(); second == nil || !second.Equal(*first) {
		t.Errorf("last_used_at moved within the 5-minute window: %v -> %v", first, second)
	}

	// Once the stamp is stale, the next request refreshes it.
	f.exec(`UPDATE "api_key" SET "last_used_at" = now() - interval '10 minutes'`)
	stale := lastUsed()
	call()
	if fresh := lastUsed(); fresh == nil || !fresh.After(*stale) {
		t.Errorf("last_used_at = %v, want a value newer than the stale %v", fresh, stale)
	}
}

// -------------------------------------------------------------------------
// RejectAPIKey — REF §A5 item 6
// -------------------------------------------------------------------------

func TestRejectAPIKeyBlocksKeysAndAllowsSessions(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{})

	chain := func(p *probe) http.Handler {
		return middleware.APIKeyAuth(f.deps)(
			middleware.Session(f.deps)(
				middleware.RequireFamily(f.deps)(
					middleware.RejectAPIKey()(p.handler()))))
	}

	keyProbe := &probe{}
	keyReq := httptest.NewRequest(http.MethodGet, "/api/push/subscriptions", nil)
	keyReq.Header.Set("Authorization", "Bearer "+token)
	keyRec := httptest.NewRecorder()
	chain(keyProbe).ServeHTTP(keyRec, keyReq)
	assertRejected(t, keyRec, keyProbe, http.StatusForbidden, "FORBIDDEN")

	sessionProbe := &probe{}
	sessionReq := httptest.NewRequest(http.MethodGet, "/api/push/subscriptions", nil)
	sessionReq.AddCookie(cookie)
	sessionRec := httptest.NewRecorder()
	chain(sessionProbe).ServeHTTP(sessionRec, sessionReq)
	if sessionRec.Code != http.StatusOK {
		t.Fatalf("a cookie session was rejected: %d %s", sessionRec.Code, sessionRec.Body.String())
	}
}

// -------------------------------------------------------------------------
// RequireSysadmin — REF §A5 item 4
// -------------------------------------------------------------------------

func TestRequireSysadmin(t *testing.T) {
	f := newFixture(t)
	userID, cookie := f.signIn("Parent", "parent@example.com")
	familyID := f.family(userID, cookie.Value, "Hansen")
	token := f.createAPIKey(familyID, userID, apiKeyOpts{})

	chain := func(p *probe) http.Handler {
		return middleware.APIKeyAuth(f.deps)(
			middleware.Session(f.deps)(
				middleware.RequireSysadmin()(p.handler())))
	}

	t.Run("anonymous", func(t *testing.T) {
		p := &probe{}
		rec := httptest.NewRecorder()
		chain(p).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil))
		assertRejected(t, rec, p, http.StatusUnauthorized, "UNAUTHENTICATED")
	})

	t.Run("api key", func(t *testing.T) {
		p := &probe{}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		chain(p).ServeHTTP(rec, req)
		assertRejected(t, rec, p, http.StatusForbidden, "FORBIDDEN")
	})

	t.Run("ordinary user", func(t *testing.T) {
		p := &probe{}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		chain(p).ServeHTTP(rec, req)
		assertRejected(t, rec, p, http.StatusForbidden, "FORBIDDEN")
	})

	t.Run("system admin", func(t *testing.T) {
		f.exec(`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, userID)
		p := &probe{}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		chain(p).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
		}
		if p.session == nil || p.session.UserID != userID {
			t.Errorf("the admin surface cannot see its caller: %+v", p.session)
		}
	})
}

// -------------------------------------------------------------------------
// RateLimit — REF §A5 item 8
// -------------------------------------------------------------------------

func TestRateLimitAllowsUpToTheLimitThenRefuses(t *testing.T) {
	f := newFixture(t)
	p := &probe{}
	handler := middleware.RateLimit(f.deps.RateLimit, "test-limit", 3, 600, false, 0)(p.handler())

	for i := 1; i <= 3; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/thing", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i, rec.Code)
		}
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	message, code := envelope(t, rec)
	if message != "Too many attempts, try again later" || code != "RATE_LIMITED" {
		t.Errorf("body = {%q, %q}, want {\"Too many attempts, try again later\", \"RATE_LIMITED\"}", message, code)
	}
}

// Buckets are per client, and the client is only read off X-Forwarded-For
// when the operator has declared trusted hops.
func TestRateLimitBucketsPerClientAddress(t *testing.T) {
	f := newFixture(t)
	p := &probe{}
	handler := middleware.RateLimit(f.deps.RateLimit, "test-per-ip", 1, 600, false, 1)(p.handler())

	send := func(forwarded string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
		req.Header.Set("X-Forwarded-For", forwarded)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := send("203.0.113.1"); code != http.StatusOK {
		t.Fatalf("first request from .1: %d", code)
	}
	if code := send("203.0.113.1"); code != http.StatusTooManyRequests {
		t.Fatalf("second request from .1: %d, want 429", code)
	}
	if code := send("203.0.113.2"); code != http.StatusOK {
		t.Fatalf("first request from .2: %d, want 200 — buckets are per client", code)
	}
}

// The bucket is a hash, never the address (a privacy commitment that outlived
// the KV namespace that forced it).
func TestRateLimitStoresHashedAddressesOnly(t *testing.T) {
	f := newFixture(t)
	p := &probe{}
	handler := middleware.RateLimit(f.deps.RateLimit, "test-hash", 5, 600, false, 1)(p.handler())

	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	var key string
	if err := f.rig.Pool.QueryRow(f.ctx, `SELECT "key" FROM "rate_limit"`).Scan(&key); err != nil {
		t.Fatalf("read counter key: %v", err)
	}
	if strings.Contains(key, "203.0.113.9") {
		t.Errorf("counter key records the raw address: %s", key)
	}
	sum := sha256.Sum256([]byte("203.0.113.9"))
	want := hex.EncodeToString(sum[:])[:32]
	if !strings.Contains(key, want) {
		t.Errorf("key = %q, want it to carry the 32-char address digest %q", key, want)
	}
	if !strings.HasPrefix(key, "rl:test-hash:") {
		t.Errorf("key = %q, want the rl:{name}:{bucket}:{window} shape", key)
	}
}

// A global bucket is shared by every client: it defeats distributed guessing
// at the cost of shared-fate 429s.
func TestRateLimitGlobalScopeSharesOneBucket(t *testing.T) {
	f := newFixture(t)
	p := &probe{}
	handler := middleware.RateLimit(f.deps.RateLimit, "test-global", 1, 600, true, 1)(p.handler())

	send := func(forwarded string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
		req.Header.Set("X-Forwarded-For", forwarded)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := send("203.0.113.1"); code != http.StatusOK {
		t.Fatalf("first request: %d", code)
	}
	if code := send("203.0.113.2"); code != http.StatusTooManyRequests {
		t.Fatalf("a different client got %d, want 429 from the shared bucket", code)
	}

	var key string
	if err := f.rig.Pool.QueryRow(f.ctx, `SELECT "key" FROM "rate_limit"`).Scan(&key); err != nil {
		t.Fatalf("read counter key: %v", err)
	}
	if !strings.HasPrefix(key, "rl:test-global:global:") {
		t.Errorf("key = %q, want the global bucket", key)
	}
}

// -------------------------------------------------------------------------
// TrustedProxy — the RemoteAddr rewrite everything else depends on
// -------------------------------------------------------------------------

func TestTrustedProxyRewritesRemoteAddr(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr })

	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil) // RemoteAddr 192.0.2.1:1234
	req.Header.Set("X-Forwarded-For", "198.51.100.7, 203.0.113.5")
	middleware.TrustedProxy(1)(next).ServeHTTP(httptest.NewRecorder(), req)

	host, _, err := net.SplitHostPort(seen)
	if err != nil {
		host = seen
	}
	if host != "203.0.113.5" {
		t.Errorf("RemoteAddr = %q, want the address the trusted proxy saw (203.0.113.5)", seen)
	}
	if req.RemoteAddr != "192.0.2.1:1234" {
		t.Errorf("the original request was mutated: RemoteAddr = %q", req.RemoteAddr)
	}
}

// RFC 7230 lets a proxy append its observation as a SEPARATE header line, and
// nginx-class ingresses do. Reading only the first line would leave
// hop-counting inside client-supplied data while the trusted proxy's actual
// observation sat unseen in the second — a forged client address.
func TestTrustedProxyReadsEveryForwardedForLine(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr })

	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	// The client forged a chain; the proxy appended what it really saw.
	req.Header.Add("X-Forwarded-For", "9.9.9.9, 198.51.100.7")
	req.Header.Add("X-Forwarded-For", "203.0.113.5")
	middleware.TrustedProxy(1)(next).ServeHTTP(httptest.NewRecorder(), req)

	host, _, err := net.SplitHostPort(seen)
	if err != nil {
		host = seen
	}
	if host == "198.51.100.7" {
		t.Fatal("only the first X-Forwarded-For line was read: the client's forged chain won")
	}
	if host != "203.0.113.5" {
		t.Errorf("RemoteAddr = %q, want the address the trusted proxy appended (203.0.113.5)", seen)
	}
}

// The same header handling on the limiter's own address resolution: a
// multi-line header and the equivalent single-line one must land in the SAME
// bucket, or an attacker splits the header and gets a fresh one per request.
func TestRateLimitReadsEveryForwardedForLine(t *testing.T) {
	f := newFixture(t)
	p := &probe{}
	handler := middleware.RateLimit(f.deps.RateLimit, "test-multiline", 1, 600, false, 1)(p.handler())

	multi := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	multi.Header.Add("X-Forwarded-For", "9.9.9.9, 198.51.100.7")
	multi.Header.Add("X-Forwarded-For", "203.0.113.5")
	multiRec := httptest.NewRecorder()
	handler.ServeHTTP(multiRec, multi)
	if multiRec.Code != http.StatusOK {
		t.Fatalf("first request: %d", multiRec.Code)
	}

	single := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	single.Header.Set("X-Forwarded-For", "9.9.9.9, 198.51.100.7, 203.0.113.5")
	singleRec := httptest.NewRecorder()
	handler.ServeHTTP(singleRec, single)
	if singleRec.Code != http.StatusTooManyRequests {
		t.Errorf("the single-line equivalent got %d, want 429 — it must share the bucket", singleRec.Code)
	}
}

func TestTrustedProxyIsInertWithoutTrustedHops(t *testing.T) {
	var seen string
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr })

	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	req.Header.Set("X-Forwarded-For", "198.51.100.7")
	middleware.TrustedProxy(0)(next).ServeHTTP(httptest.NewRecorder(), req)

	if seen != "192.0.2.1:1234" {
		t.Errorf("RemoteAddr = %q, want the untouched socket address — a forged header must not be read", seen)
	}
}
