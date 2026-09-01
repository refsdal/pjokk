package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Invite codes — ports apps/api/test/invites.test.ts's "invite codes"
// describe block, plus the case-insensitivity assertions from
// apps/api/test/defects.test.ts's "invite codes are case-insensitive"
// block, plus rate-limit coverage (REF §A5's invite-info/invite-redeem
// limits) neither TS file exercises end-to-end the way this file does.
// -----------------------------------------------------------------------

func inviteUsedCount(t *testing.T, a *testrig.AppRig, code string) int {
	t.Helper()
	var n int
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "used_count" FROM "family_invite" WHERE "code" = $1`, code,
	).Scan(&n); err != nil {
		t.Fatalf("inviteUsedCount(%q): %v", code, err)
	}
	return n
}

func TestCreateInviteDefaultsBoundsAndMemberForbidden(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")

	// Defaults: an empty body (and a wholly absent one) both mean
	// role=member, expiresInHours=72, maxUses=5.
	defaulted := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{})
	if defaulted.Status != http.StatusCreated {
		t.Fatalf("POST {} status = %d, body %s", defaulted.Status, defaulted.Raw)
	}
	if defaulted.JSON["role"] != "member" {
		t.Errorf("role = %v, want default %q", defaulted.JSON["role"], "member")
	}
	if defaulted.JSON["maxUses"] != float64(5) {
		t.Errorf("maxUses = %v, want default 5", defaulted.JSON["maxUses"])
	}
	if defaulted.JSON["familyId"] != familyID {
		t.Errorf("familyId = %v, want %q", defaulted.JSON["familyId"], familyID)
	}
	code, _ := defaulted.JSON["code"].(string)
	if code == "" {
		t.Fatalf("code missing from %v", defaulted.JSON)
	}
	url, _ := defaulted.JSON["url"].(string)
	if want := "/join/" + code; !strings.Contains(url, want) {
		t.Errorf("url = %q, want it to contain %q", url, want)
	}
	expiresAt, _ := time.Parse(time.RFC3339, fmt.Sprint(defaulted.JSON["expiresAt"]))
	if d := time.Until(expiresAt); d < 71*time.Hour || d > 73*time.Hour {
		t.Errorf("expiresAt = %v, want ~72h from now (got %v)", defaulted.JSON["expiresAt"], d)
	}

	// Explicit values are honoured.
	explicit := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{
		"role": "admin", "expiresInHours": 1, "maxUses": 50,
	})
	if explicit.Status != http.StatusCreated {
		t.Fatalf("POST explicit status = %d, body %s", explicit.Status, explicit.Raw)
	}
	if explicit.JSON["role"] != "admin" || explicit.JSON["maxUses"] != float64(50) {
		t.Errorf("explicit body = %v, want role=admin maxUses=50", explicit.JSON)
	}

	// Bounds are enforced (spec validation, before the handler ever runs).
	for _, bad := range []map[string]any{
		{"maxUses": 51},
		{"maxUses": 0},
		{"expiresInHours": 0},
		{"expiresInHours": 721},
		{"role": "owner"},
	} {
		res := a.Do(http.MethodPost, "/api/invites", cookie, bad)
		if res.Status != http.StatusBadRequest {
			t.Errorf("POST %v status = %d, body %s, want 400", bad, res.Status, res.Raw)
		}
		if res.JSON["code"] != "VALIDATION" {
			t.Errorf("POST %v code = %v, want VALIDATION", bad, res.JSON["code"])
		}
	}

	// Plain members cannot create invites.
	memberID := a.SignUp("Plain member", "member@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "member@example.com")
	denied := a.Do(http.MethodPost, "/api/invites", memberCookie, map[string]any{})
	if denied.Status != http.StatusForbidden {
		t.Errorf("member POST status = %d, body %s, want 403", denied.Status, denied.Raw)
	}
}

func TestInvitesMemberForbiddenAdminFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", adminCookie, map[string]any{})
	if created.Status != http.StatusCreated {
		t.Fatalf("admin POST status = %d, body %s", created.Status, created.Raw)
	}
	code, _ := created.JSON["code"].(string)

	memberID := a.SignUp("Reader", "reader@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "reader@example.com")

	memberList := a.DoArray(http.MethodGet, "/api/invites", memberCookie, nil)
	if memberList.Status != http.StatusForbidden {
		t.Errorf("member GET status = %d, body %s, want 403", memberList.Status, memberList.Raw)
	}
	memberRevoke := a.Do(http.MethodDelete, "/api/invites/"+code, memberCookie, nil)
	if memberRevoke.Status != http.StatusForbidden {
		t.Errorf("member DELETE status = %d, body %s, want 403", memberRevoke.Status, memberRevoke.Raw)
	}

	// Cross-family isolation: a second family's admin sees none of the
	// first family's invites and cannot revoke them (404, not 403 — the
	// row is simply not theirs to find).
	_, otherCookie := a.NewFamily("Other family", "other@example.com")
	otherList := a.DoArray(http.MethodGet, "/api/invites", otherCookie, nil)
	if len(otherList.JSON) != 0 {
		t.Errorf("other family's invite list = %v, want empty", otherList.JSON)
	}
	otherRevoke := a.Do(http.MethodDelete, "/api/invites/"+code, otherCookie, nil)
	if otherRevoke.Status != http.StatusNotFound {
		t.Errorf("other family DELETE status = %d, body %s, want 404", otherRevoke.Status, otherRevoke.Raw)
	}

	list := a.DoArray(http.MethodGet, "/api/invites", adminCookie, nil)
	if len(list.JSON) != 1 {
		t.Errorf("admin's invite list = %v, want exactly one (unaffected)", list.JSON)
	}
}

func TestRevokeInvite(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{})
	code, _ := created.JSON["code"].(string)

	revoke := a.Do(http.MethodDelete, "/api/invites/"+code, cookie, nil)
	if revoke.Status != http.StatusOK || revoke.JSON["ok"] != true {
		t.Fatalf("DELETE status = %d, body %s, want 200 {ok:true}", revoke.Status, revoke.Raw)
	}

	reRevoke := a.Do(http.MethodDelete, "/api/invites/"+code, cookie, nil)
	if reRevoke.Status != http.StatusNotFound {
		t.Errorf("re-DELETE status = %d, body %s, want 404", reRevoke.Status, reRevoke.Raw)
	}
}

func TestRedeemAddsMembershipAndIncrementsUseAtomically(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{
		"role": "member", "expiresInHours": 72, "maxUses": 2,
	})
	code, _ := created.JSON["code"].(string)

	a.SignUp("Newcomer", "newcomer@example.com")
	newcomerCookie := a.SignIn("newcomer@example.com")

	before := a.DoArray(http.MethodGet, "/api/babies", newcomerCookie, nil)
	if before.Status != http.StatusForbidden {
		t.Fatalf("GET /api/babies before redeem: status = %d, want 403 (no family yet)", before.Status)
	}

	redeem := a.Do(http.MethodPost, "/api/invites/redeem", newcomerCookie, map[string]any{"code": code})
	if redeem.Status != http.StatusOK {
		t.Fatalf("redeem status = %d, body %s", redeem.Status, redeem.Raw)
	}
	if redeem.JSON["familyId"] != familyID {
		t.Errorf("familyId = %v, want %q", redeem.JSON["familyId"], familyID)
	}
	if redeem.JSON["alreadyMember"] != false {
		t.Errorf("alreadyMember = %v, want false", redeem.JSON["alreadyMember"])
	}
	if got := inviteUsedCount(t, a, code); got != 1 {
		t.Errorf("usedCount = %d, want 1", got)
	}

	// Redeem set the active organization: domain routes now work.
	after := a.DoArray(http.MethodGet, "/api/babies", newcomerCookie, nil)
	if after.Status != http.StatusOK {
		t.Fatalf("GET /api/babies after redeem: status = %d, body %s", after.Status, after.Raw)
	}

	// The membership itself is durable, not just that one session's active
	// family: a completely fresh sign-in (new session, no active family
	// yet) redeems the SAME code again — alreadyMember this time, since
	// InsertOrganizationMember's row persisted — and, once its own
	// setActive runs, sees the family too. This is the check that the
	// hand-written organization_members/organization_member_roles insert
	// inside redeemInviteTx produced rows RequireFamily's own membership
	// query (the same one every other route relies on) actually
	// recognises — not just something this test's own SQL can see.
	freshCookie := a.SignIn("newcomer@example.com")
	beforeFresh := a.DoArray(http.MethodGet, "/api/babies", freshCookie, nil)
	if beforeFresh.Status != http.StatusForbidden {
		t.Fatalf("GET /api/babies (fresh session, no active family yet): status = %d, want 403", beforeFresh.Status)
	}
	again := a.Do(http.MethodPost, "/api/invites/redeem", freshCookie, map[string]any{"code": code})
	if again.Status != http.StatusOK || again.JSON["alreadyMember"] != true {
		t.Fatalf("re-redeem from fresh session: status = %d, body %s, want 200 alreadyMember:true", again.Status, again.Raw)
	}
	afterFresh := a.DoArray(http.MethodGet, "/api/babies", freshCookie, nil)
	if afterFresh.Status != http.StatusOK {
		t.Fatalf("GET /api/babies (fresh session, after re-redeem): status = %d, body %s", afterFresh.Status, afterFresh.Raw)
	}
}

func TestRedeemAsExistingMemberBurnsNoUse(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{})
	code, _ := created.JSON["code"].(string)

	redeem := a.Do(http.MethodPost, "/api/invites/redeem", cookie, map[string]any{"code": code})
	if redeem.Status != http.StatusOK {
		t.Fatalf("redeem status = %d, body %s", redeem.Status, redeem.Raw)
	}
	if redeem.JSON["alreadyMember"] != true {
		t.Errorf("alreadyMember = %v, want true", redeem.JSON["alreadyMember"])
	}
	if got := inviteUsedCount(t, a, code); got != 0 {
		t.Errorf("usedCount = %d, want 0 (already-member redeem burns no use)", got)
	}
}

// TestRedeemConcurrentDifferentCodesNeverSurfaceA500 exercises the race
// redeemInviteTx's own FOR UPDATE lock cannot close: the SAME user
// redeeming TWO DIFFERENT codes for the SAME family concurrently. Each
// code's lock only serializes against redeems of THAT code, so a redeem of
// codeB can pass its own membership pre-check (0 members, under READ
// COMMITTED, an uncommitted concurrent insert is invisible) and only
// discover the conflict when its own INSERT collides with
// idx_organization_members_org_user (00002_limen_align.sql) — which must
// fold into the ordinary "cannot redeem" 400 rather than surface a raw 500
// (see redeemInviteTx's db.IsUniqueViolation branch).
//
// A best-effort goroutine race (fire N concurrent HTTP redeems and hope
// two land in the same microsecond window) was tried first and never
// actually hit this window against a local Postgres — the whole
// request/transaction round trip is fast enough that requests serialize in
// practice more often than not, which would make the test pass whether or
// not the fix exists (a regression it doesn't actually cover). This
// version forces the window deterministically instead: hold open a raw,
// UNCOMMITTED transaction that has already inserted the racer's
// organization_members row, launch the HTTP redeem of codeB in a
// goroutine, poll pg_stat_activity until that goroutine's own INSERT is
// observably blocked waiting on the held row's lock (proof the race
// window is open), and only then commit — at which point the goroutine's
// INSERT resumes into a guaranteed 23505.
func TestRedeemConcurrentDifferentCodesNeverSurfaceA500(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{"maxUses": 5})
	if created.Status != http.StatusCreated {
		t.Fatalf("create codeB: status = %d, body %s", created.Status, created.Raw)
	}
	codeB, _ := created.JSON["code"].(string)

	racerUserID := a.SignUp("Racer", "racer@example.com")
	racerCookie := a.SignIn("racer@example.com")

	// Hold the racer's membership insert open, uncommitted — simulating a
	// concurrent redeem of a DIFFERENT code (codeA) that reached the same
	// INSERT first but hasn't committed yet.
	holdTx, err := a.Rig.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin holding tx: %v", err)
	}
	defer func() { _ = holdTx.Rollback(ctx) }()
	if _, err := holdTx.Exec(ctx,
		`INSERT INTO "organization_members" ("organization_id", "user_id") VALUES ($1, $2)`,
		familyID, racerUserID,
	); err != nil {
		t.Fatalf("hold insert: %v", err)
	}

	type redeemResult struct {
		status int
		body   string
	}
	resultCh := make(chan redeemResult, 1)
	go func() {
		res := a.Do(http.MethodPost, "/api/invites/redeem", racerCookie, map[string]any{"code": codeB})
		resultCh <- redeemResult{res.Status, string(res.Raw)}
	}()

	// Wait until the goroutine's INSERT is genuinely blocked on the held
	// row's lock before releasing it.
	deadline := time.Now().Add(5 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		var n int
		if err := a.Rig.Pool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			WHERE wait_event_type = 'Lock' AND query ILIKE '%organization_members%'`,
		).Scan(&n); err != nil {
			t.Fatalf("poll pg_stat_activity: %v", err)
		}
		if n > 0 {
			blocked = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("redeem of codeB never blocked on the held membership row — the race window was not exercised")
	}

	if err := holdTx.Commit(ctx); err != nil {
		t.Fatalf("commit holding tx: %v", err)
	}

	res := <-resultCh
	if res.status == http.StatusInternalServerError {
		t.Fatalf("redeem of codeB while a same-user/same-family membership insert was in flight: "+
			"status = 500, body %s — the unique violation must be folded into 400, not surfaced raw", res.body)
	}
	if res.status != http.StatusBadRequest {
		t.Errorf("redeem of codeB: status = %d, body %s, want 400 (already a member by the time this committed)",
			res.status, res.body)
	}

	var memberCount int
	if err := a.Rig.Pool.QueryRow(ctx, `
		SELECT COUNT(*)::int FROM "organization_members"
		WHERE "organization_id" = $1 AND "user_id" = $2`,
		familyID, racerUserID,
	).Scan(&memberCount); err != nil {
		t.Fatalf("count membership: %v", err)
	}
	if memberCount != 1 {
		t.Errorf("membership rows for the racing user = %d, want exactly 1 (no duplicate from the race)", memberCount)
	}
}

func TestRedeemRejectsExpiredRevokedExhaustedAndUnknownCodes(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	ctx := context.Background()

	make := func(body map[string]any) string {
		res := a.Do(http.MethodPost, "/api/invites", cookie, body)
		if res.Status != http.StatusCreated {
			t.Fatalf("create invite: status = %d, body %s", res.Status, res.Raw)
		}
		code, _ := res.JSON["code"].(string)
		return code
	}

	expired := make(map[string]any{"expiresInHours": 1, "maxUses": 5})
	if _, err := a.Rig.Pool.Exec(ctx,
		`UPDATE "family_invite" SET "expires_at" = $1 WHERE "code" = $2`,
		time.Now().Add(-time.Second), expired,
	); err != nil {
		t.Fatalf("force-expire: %v", err)
	}

	revoked := make(map[string]any{})
	if res := a.Do(http.MethodDelete, "/api/invites/"+revoked, cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("revoke: status = %d, body %s", res.Status, res.Raw)
	}

	exhausted := make(map[string]any{"maxUses": 1})
	if _, err := a.Rig.Pool.Exec(ctx,
		`UPDATE "family_invite" SET "used_count" = 1 WHERE "code" = $1`, exhausted,
	); err != nil {
		t.Fatalf("force-exhaust: %v", err)
	}

	a.SignUp("Outsider", "outsider@example.com")
	outsiderCookie := a.SignIn("outsider@example.com")

	for _, code := range []string{expired, revoked, exhausted, "NOPE"} {
		res := a.Do(http.MethodPost, "/api/invites/redeem", outsiderCookie, map[string]any{"code": code})
		if res.Status != http.StatusBadRequest {
			t.Errorf("redeem %q: status = %d, body %s, want 400", code, res.Status, res.Raw)
		}
		if res.JSON["code"] != "INVALID_INVITE" {
			t.Errorf("redeem %q: code = %v, want INVALID_INVITE", code, res.JSON["code"])
		}
	}
	// The unknown-code message names the classification exactly.
	unknown := a.Do(http.MethodPost, "/api/invites/redeem", outsiderCookie, map[string]any{"code": "NOPE"})
	if unknown.JSON["error"] != "Invite not_found" {
		t.Errorf("redeem NOPE error = %v, want %q", unknown.JSON["error"], "Invite not_found")
	}

	// The invalid attempts changed nothing.
	if got := inviteUsedCount(t, a, exhausted); got != 1 {
		t.Errorf("usedCount = %d, want unchanged at 1", got)
	}
	stillNoFamily := a.DoArray(http.MethodGet, "/api/babies", outsiderCookie, nil)
	if stillNoFamily.Status != http.StatusForbidden {
		t.Errorf("GET /api/babies status = %d, want 403 (outsider never joined)", stillNoFamily.Status)
	}
}

func TestInviteInfoExposesSafeStatus(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("The Pjokk family", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{})
	code, _ := created.JSON["code"].(string)

	info := a.Do(http.MethodGet, "/api/invites/info/"+code, "", nil)
	if info.Status != http.StatusOK {
		t.Fatalf("GET info status = %d, body %s", info.Status, info.Raw)
	}
	if info.JSON["valid"] != true {
		t.Errorf("valid = %v, want true", info.JSON["valid"])
	}
	if info.JSON["familyName"] != "The Pjokk family" {
		t.Errorf("familyName = %v, want %q", info.JSON["familyName"], "The Pjokk family")
	}
	if info.JSON["role"] != "member" {
		t.Errorf("role = %v, want %q", info.JSON["role"], "member")
	}

	bad := a.Do(http.MethodGet, "/api/invites/info/NOPE", "", nil)
	if bad.JSON["valid"] != false {
		t.Errorf("valid = %v, want false", bad.JSON["valid"])
	}
	if bad.JSON["reason"] != "not_found" {
		t.Errorf("reason = %v, want not_found", bad.JSON["reason"])
	}
}

func TestInviteCodesAreCaseInsensitive(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{})
	code, _ := created.JSON["code"].(string)
	lower := strings.ToLower(code)

	info := a.Do(http.MethodGet, "/api/invites/info/"+lower, "", nil)
	if info.JSON["valid"] != true {
		t.Errorf("lowercase info: valid = %v, want true", info.JSON["valid"])
	}

	a.SignUp("Lowercase guest", "guest@example.com")
	guestCookie := a.SignIn("guest@example.com")
	redeem := a.Do(http.MethodPost, "/api/invites/redeem", guestCookie, map[string]any{"code": lower})
	if redeem.Status != http.StatusOK {
		t.Errorf("lowercase redeem: status = %d, body %s, want 200", redeem.Status, redeem.Raw)
	}
}

func TestRedeemRequiresSignIn(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	created := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{})
	code, _ := created.JSON["code"].(string)

	res := a.Do(http.MethodPost, "/api/invites/redeem", "", map[string]any{"code": code})
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, body %s, want 401", res.Status, res.Raw)
	}
	if res.JSON["code"] != "UNAUTHENTICATED" {
		t.Errorf("code = %v, want UNAUTHENTICATED", res.JSON["code"])
	}
}

// Rate limits — REF §A5's invite-info (30/10min per client, 500/10min
// global) and invite-redeem (10/10min per client, 200/10min global).
// httptest.NewRequest fixes RemoteAddr to the same value on every call
// (see net/http/httptest), so every request AppRig.Do issues in one test
// lands in the same per-client bucket — no need to fake the client address
// by hand.

func TestInviteInfoIsRateLimited(t *testing.T) {
	a := testrig.App(t)
	limited := false
	for i := 0; i < 35; i++ {
		res := a.Do(http.MethodGet, "/api/invites/info/NOPE", "", nil)
		if res.Status == http.StatusTooManyRequests {
			if res.JSON["code"] != "RATE_LIMITED" {
				t.Errorf("attempt %d: code = %v, want RATE_LIMITED", i, res.JSON["code"])
			}
			limited = true
			break
		}
		if res.Status != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, body %s, want 200", i, res.Status, res.Raw)
		}
	}
	if !limited {
		t.Fatal("30 requests from one client never tripped the invite-info limiter")
	}
}

func TestRedeemIsRateLimited(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Brute", "brute@example.com")
	cookie := a.SignIn("brute@example.com")

	limited := false
	for i := 0; i < 15; i++ {
		res := a.Do(http.MethodPost, "/api/invites/redeem", cookie, map[string]any{"code": fmt.Sprintf("GUESS%d", i)})
		if res.Status == http.StatusTooManyRequests {
			if res.JSON["code"] != "RATE_LIMITED" {
				t.Errorf("attempt %d: code = %v, want RATE_LIMITED", i, res.JSON["code"])
			}
			limited = true
			break
		}
		if res.Status != http.StatusBadRequest {
			t.Fatalf("attempt %d: status = %d, body %s, want 400 (bogus code)", i, res.Status, res.Raw)
		}
	}
	if !limited {
		t.Fatal("10 requests from one client never tripped the invite-redeem limiter")
	}
}
