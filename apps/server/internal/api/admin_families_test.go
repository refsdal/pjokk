package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Admin-side family management —
// docs/superpowers/specs/2026-09-08-admin-family-management-design.md.
//
// Unlike admin_test.go this file ports no TypeScript test: the predecessor
// console had no family detail page and no way to create, rename or staff a
// family at all.
//
// It shares admin_test.go's helpers (sysadminRig, makeSysadmin,
// userIDByEmail, findAudit, auditRows, bearerDo) — same package.
// -----------------------------------------------------------------------

// memberOf digs one member out of a GET /api/admin/families/{id} payload by
// email. The detail response is deeply nested `any`, and every test that
// checks a role would otherwise repeat the same four type assertions.
func memberOf(t *testing.T, detail map[string]any, email string) map[string]any {
	t.Helper()
	members, _ := detail["members"].([]any)
	for _, m := range members {
		row, _ := m.(map[string]any)
		if row["email"] == email {
			return row
		}
	}
	t.Fatalf("no member %q in %v", email, members)
	return nil
}

// countRows is a small direct-SQL probe, used where the assertion is about
// what is (or is not) in the database rather than what an endpoint says.
func countRows(t *testing.T, a *testrig.AppRig, query string, args ...any) int {
	t.Helper()
	var n int
	if err := a.Rig.Pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count(%q): %v", query, err)
	}
	return n
}

// -----------------------------------------------------------------------
// The gate
// -----------------------------------------------------------------------

// Every new route refuses a family admin, an anonymous caller and an API
// key. The family-admin case is the one worth stating explicitly: these
// routes look like the tierAdmin family surface and are NOT it — a parent
// who is an admin of the very family in the path still gets 403, because
// managing a family from outside it is a system-admin power.
func TestAdminFamilyRoutesRequireSysadmin(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	userID := userIDByEmail(t, a, "parent@example.com")
	key := a.CreateAPIKey(familyID, userID)

	base := "/api/admin/families/" + familyID
	routes := []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/admin/families", map[string]any{"name": "New"}},
		{http.MethodGet, base, nil},
		{http.MethodPatch, base, map[string]any{"name": "Renamed"}},
		{http.MethodPost, base + "/members", map[string]any{"email": "x@example.com", "role": "member"}},
		{http.MethodDelete, base + "/members/whatever", nil},
		{http.MethodPost, base + "/members/whatever/role", map[string]any{"role": "admin"}},
		{http.MethodPost, base + "/invites", nil},
		{http.MethodDelete, base + "/invites/ABCD1234", nil},
		{http.MethodDelete, base + "/keys/some-key", nil},
	}

	for _, route := range routes {
		res := a.Do(route.method, route.path, cookie, route.body)
		if res.Status != http.StatusForbidden || res.JSON["code"] != "FORBIDDEN" {
			t.Errorf("%s %s as a family admin = %d %s, want 403 FORBIDDEN",
				route.method, route.path, res.Status, res.Raw)
		}

		anon := a.Do(route.method, route.path, "", route.body)
		if anon.Status != http.StatusUnauthorized || anon.JSON["code"] != "UNAUTHENTICATED" {
			t.Errorf("%s %s anonymous = %d %s, want 401 UNAUTHENTICATED",
				route.method, route.path, anon.Status, anon.Raw)
		}

		withKey := bearerDo(a, route.method, route.path, key, route.body)
		if withKey.Status != http.StatusForbidden || withKey.JSON["code"] != "FORBIDDEN" {
			t.Errorf("%s %s with an API key = %d %s, want 403 FORBIDDEN",
				route.method, route.path, withKey.Status, withKey.Raw)
		}
	}
}

// -----------------------------------------------------------------------
// Creation — the three behaviours
// -----------------------------------------------------------------------

func TestAdminCreateFamilyWithExistingAccount(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Ops")
	parentID := a.SignUp("Nora", "nora@example.com")

	res := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{
		"name":       "Dahl",
		"adminEmail": "nora@example.com",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create = %d %s, want 201", res.Status, res.Raw)
	}
	if res.JSON["slug"] == "" || res.JSON["slug"] == nil {
		t.Errorf("created family has no slug: %s", res.Raw)
	}

	first, _ := res.JSON["firstAdmin"].(map[string]any)
	if first == nil {
		t.Fatalf("no firstAdmin in %s", res.Raw)
	}
	if first["userId"] != parentID {
		t.Errorf("firstAdmin.userId = %v, want %s", first["userId"], parentID)
	}
	if first["accountCreated"] != false {
		t.Errorf("accountCreated = %v, want false — the account already existed", first["accountCreated"])
	}
	if res.JSON["invite"] != nil {
		t.Errorf("invite = %v, want null when a first admin was named", res.JSON["invite"])
	}

	// She is the family's admin, and the operator is NOT in it.
	familyID, _ := res.JSON["id"].(string)
	detail := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	members, _ := detail.JSON["members"].([]any)
	if len(members) != 1 {
		t.Fatalf("members = %v, want exactly one (the new admin)", members)
	}
	if got := memberOf(t, detail.JSON, "nora@example.com")["role"]; got != auth.RoleAdmin {
		t.Errorf("role = %v, want admin", got)
	}
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "organization_members" WHERE "organization_id" = $1 AND "user_id" = $2`,
		familyID, adminID); n != 0 {
		t.Errorf("the operator is a member of the family they created (%d rows)", n)
	}

	if entry := findAudit(t, a, "family.create"); entry.AdminID != adminID || entry.Detail != "Dahl" {
		t.Errorf("family.create audit = %+v, want admin %s detail %q", entry, adminID, "Dahl")
	}
}

// The white-glove path: no account yet, so one is provisioned — WITHOUT a
// password, which is what lets the person claim it by signing in with Google
// on the same address (Limen's OAuth plugin links by email).
func TestAdminCreateFamilyProvisionsPasswordlessAccount(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Ops")

	res := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{
		"name":          "Berg",
		"adminEmail":    "new@example.com",
		"adminName":     "Even Berg",
		"createAccount": true,
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create = %d %s, want 201", res.Status, res.Raw)
	}
	first, _ := res.JSON["firstAdmin"].(map[string]any)
	if first == nil || first["accountCreated"] != true {
		t.Fatalf("firstAdmin = %v, want accountCreated true", first)
	}

	// NULL, not a hash of something random: Limen's credential plugin reads
	// NULL as "signed up through OAuth", which keeps SetPassword available
	// as a recovery path. A throwaway hash would have locked the account out
	// of it.
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "users" WHERE "email" = $1 AND "password" IS NULL`,
		"new@example.com"); n != 1 {
		t.Errorf("provisioned account has a password set (matching rows: %d)", n)
	}

	if entry := findAudit(t, a, "user.create"); entry.AdminID != adminID || entry.Detail != "new@example.com" {
		t.Errorf("user.create audit = %+v", entry)
	}
	findAudit(t, a, "family.create")
}

// A mistyped address must not silently mint an account. This is the reason
// createAccount is an explicit flag rather than implied by "no account
// exists".
func TestAdminCreateFamilyRefusesUnknownEmailWithoutFlag(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")

	res := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{
		"name":       "Typo",
		"adminEmail": "nroa@example.com",
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("create with an unknown email = %d %s, want 404", res.Status, res.Raw)
	}
	if n := countRows(t, a, `SELECT COUNT(*) FROM "users" WHERE "email" = $1`, "nroa@example.com"); n != 0 {
		t.Errorf("a stray account was created for the typo (%d rows)", n)
	}
	if n := countRows(t, a, `SELECT COUNT(*) FROM "organizations" WHERE "name" = 'Typo'`); n != 0 {
		t.Errorf("a family was created despite the refusal (%d rows)", n)
	}
}

// createAccount without a name is refused rather than defaulting to
// something — a nameless caretaker shows up in every attribution line.
func TestAdminCreateFamilyRequiresNameWhenProvisioning(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")

	res := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{
		"name":          "Nameless",
		"adminEmail":    "nobody@example.com",
		"createAccount": true,
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("create without adminName = %d %s, want 400", res.Status, res.Raw)
	}
	if n := countRows(t, a, `SELECT COUNT(*) FROM "users" WHERE "email" = $1`, "nobody@example.com"); n != 0 {
		t.Errorf("an account was created despite the refusal (%d rows)", n)
	}
}

// The invite path. Two things matter: the code carries the ADMIN role (a
// member-role code would leave the family permanently unadministered), and
// the family comes out genuinely EMPTY — the operator must not be left
// inside it.
func TestAdminCreateFamilyWithInviteLeavesItEmpty(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Ops")

	res := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{"name": "Solo"})
	if res.Status != http.StatusCreated {
		t.Fatalf("create = %d %s, want 201", res.Status, res.Raw)
	}
	if res.JSON["firstAdmin"] != nil {
		t.Errorf("firstAdmin = %v, want null", res.JSON["firstAdmin"])
	}
	invite, _ := res.JSON["invite"].(map[string]any)
	if invite == nil {
		t.Fatalf("no invite in %s", res.Raw)
	}
	if invite["role"] != auth.RoleAdmin {
		t.Errorf("invite role = %v, want admin", invite["role"])
	}
	if url, _ := invite["url"].(string); url == "" {
		t.Errorf("invite has no join URL: %v", invite)
	}

	familyID, _ := res.JSON["id"].(string)
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "organization_members" WHERE "organization_id" = $1`, familyID); n != 0 {
		t.Fatalf("family created with %d members, want 0 — the operator was left inside it", n)
	}
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "organization_member_roles" WHERE "organization_id" = $1`, familyID); n != 0 {
		t.Errorf("family has %d dangling member-role rows, want 0", n)
	}

	// And the operator's own session did not get dragged into it.
	var active *string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "active_organization_id" FROM "sessions" WHERE "user_id" = $1 LIMIT 1`,
		adminID).Scan(&active); err != nil {
		t.Fatalf("read operator session: %v", err)
	}
	if active != nil && *active == familyID {
		t.Errorf("the operator's session was switched into the new family")
	}

	findAudit(t, a, "family.create")
	findAudit(t, a, "family.invite.create")
}

// The stranded-family badge. A family whose only admin is deleted keeps
// working and silently cannot be administered; hasAdmin is what makes that
// visible in the console.
func TestListAdminFamiliesReportsHasAdminAndFilters(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")

	empty := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{"name": "Stranded"})
	if empty.Status != http.StatusCreated {
		t.Fatalf("create = %d %s", empty.Status, empty.Raw)
	}

	all := adminList(t, a, "/api/admin/families", cookie)
	if all.Status != http.StatusOK {
		t.Fatalf("list = %d %s", all.Status, all.Raw)
	}
	byName := map[string]map[string]any{}
	for _, row := range all.JSON {
		m, _ := row.(map[string]any)
		name, _ := m["name"].(string)
		byName[name] = m
	}
	if byName["Ops"]["hasAdmin"] != true {
		t.Errorf("Ops hasAdmin = %v, want true", byName["Ops"]["hasAdmin"])
	}
	if byName["Stranded"]["hasAdmin"] != false {
		t.Errorf("Stranded hasAdmin = %v, want false", byName["Stranded"]["hasAdmin"])
	}

	filtered := adminList(t, a, "/api/admin/families?query=stran", cookie)
	if len(filtered.JSON) != 1 {
		t.Fatalf("?query=stran returned %d families, want 1: %s", len(filtered.JSON), filtered.Raw)
	}
	if row, _ := filtered.JSON[0].(map[string]any); row["name"] != "Stranded" {
		t.Errorf("?query=stran returned %v, want Stranded", row["name"])
	}
}

// -----------------------------------------------------------------------
// Detail, rename
// -----------------------------------------------------------------------

func TestAdminFamilyDetail(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")
	a.NewBaby(familyID, "Ada")
	a.CreateAPIKey(familyID, adminID)

	invite := a.Do(http.MethodPost, "/api/invites", cookie, map[string]any{"role": "member"})
	if invite.Status != http.StatusCreated {
		t.Fatalf("seed invite: %d %s", invite.Status, invite.Raw)
	}

	res := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("detail = %d %s, want 200", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Hansen" {
		t.Errorf("name = %v, want Hansen", res.JSON["name"])
	}
	for _, field := range []string{"members", "babies", "invites", "apiKeys"} {
		list, _ := res.JSON[field].([]any)
		if len(list) != 1 {
			t.Errorf("%s = %v, want exactly one entry", field, res.JSON[field])
		}
	}
	member := memberOf(t, res.JSON, "sysadmin@example.com")
	if member["role"] != auth.RoleAdmin {
		t.Errorf("role = %v, want admin", member["role"])
	}
	if member["joinedAt"] == nil || member["banned"] != false {
		t.Errorf("member = %v, want joinedAt set and banned false", member)
	}

	// Metadata only: nothing derived from a child's health record. If a
	// future change adds one of these, the privacy policy needs a clause
	// before the code does.
	for _, forbidden := range []string{"logs", "feeds", "timeline", "counts", "entries"} {
		if _, present := res.JSON[forbidden]; present {
			t.Errorf("detail payload carries %q — the console is metadata-only", forbidden)
		}
	}

	if missing := a.Do(http.MethodGet, "/api/admin/families/nope", cookie, nil); missing.Status != http.StatusNotFound {
		t.Errorf("detail of an unknown family = %d, want 404", missing.Status)
	}
}

func TestAdminRenameFamily(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")

	before := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	slug := before.JSON["slug"]

	res := a.Do(http.MethodPatch, "/api/admin/families/"+familyID, cookie, map[string]any{"name": "Hansen-Berg"})
	if res.Status != http.StatusOK {
		t.Fatalf("rename = %d %s, want 200", res.Status, res.Raw)
	}

	after := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	if after.JSON["name"] != "Hansen-Berg" {
		t.Errorf("name = %v, want Hansen-Berg", after.JSON["name"])
	}
	// The slug is an identifier something may already hold; a rename must
	// not move it.
	if after.JSON["slug"] != slug {
		t.Errorf("slug changed on rename: %v → %v", slug, after.JSON["slug"])
	}

	// Both names, because a trail that recorded only the new one is
	// unreadable a month later.
	if entry := findAudit(t, a, "family.rename"); entry.AdminID != adminID || entry.Detail != "Hansen → Hansen-Berg" {
		t.Errorf("family.rename audit = %+v, want detail %q", entry, "Hansen → Hansen-Berg")
	}

	if missing := a.Do(http.MethodPatch, "/api/admin/families/nope", cookie, map[string]any{"name": "x"}); missing.Status != http.StatusNotFound {
		t.Errorf("rename of an unknown family = %d, want 404", missing.Status)
	}
}

// -----------------------------------------------------------------------
// Membership
// -----------------------------------------------------------------------

func TestAdminAddFamilyMember(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")
	a.SignUp("Kari", "kari@example.com")

	res := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members", cookie,
		map[string]any{"email": "kari@example.com", "role": "member"})
	if res.Status != http.StatusOK {
		t.Fatalf("add = %d %s, want 200", res.Status, res.Raw)
	}

	detail := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	if got := memberOf(t, detail.JSON, "kari@example.com")["role"]; got != auth.RoleMember {
		t.Errorf("role = %v, want member", got)
	}
	if entry := findAudit(t, a, "family.member.add"); entry.AdminID != adminID || entry.Detail != "kari@example.com as member" {
		t.Errorf("family.member.add audit = %+v", entry)
	}

	// Adding her twice is an explainable refusal, not a 500 from a rejected
	// write.
	again := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members", cookie,
		map[string]any{"email": "kari@example.com", "role": "member"})
	if again.Status != http.StatusBadRequest || again.JSON["code"] != "REFUSED" {
		t.Errorf("adding an existing member = %d %s, want 400 REFUSED", again.Status, again.Raw)
	}

	// This route never creates an account — that path exists once, on
	// CreateAdminFamily, behind an explicit flag.
	unknown := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members", cookie,
		map[string]any{"email": "ghost@example.com", "role": "member"})
	if unknown.Status != http.StatusNotFound {
		t.Errorf("adding an unknown email = %d %s, want 404", unknown.Status, unknown.Raw)
	}
	if n := countRows(t, a, `SELECT COUNT(*) FROM "users" WHERE "email" = $1`, "ghost@example.com"); n != 0 {
		t.Errorf("adding an unknown email created an account (%d rows)", n)
	}
}

// The last-admin guard binds system admins too. An operator can delete the
// whole family — that outcome is understood — but must not leave one running
// with nobody able to administer it.
func TestAdminMemberGuardsProtectTheLastAdmin(t *testing.T) {
	a, familyID, cookie, _ := sysadminRig(t, "Hansen")
	adminID := userIDByEmail(t, a, "sysadmin@example.com")

	detail := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	adminMemberID, _ := memberOf(t, detail.JSON, "sysadmin@example.com")["memberId"].(string)

	demote := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members/"+adminMemberID+"/role",
		cookie, map[string]any{"role": "member"})
	if demote.Status != http.StatusBadRequest || demote.JSON["code"] != "REFUSED" {
		t.Errorf("demoting the last admin = %d %s, want 400 REFUSED", demote.Status, demote.Raw)
	}

	remove := a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/members/"+adminMemberID, cookie, nil)
	if remove.Status != http.StatusBadRequest || remove.JSON["code"] != "REFUSED" {
		t.Errorf("removing the last admin = %d %s, want 400 REFUSED", remove.Status, remove.Raw)
	}

	// Promote someone else, and both become possible — which is why the
	// guard is not an obstacle in practice.
	kariID := a.SignUp("Kari", "kari@example.com")
	a.AddMember(familyID, kariID, auth.RoleMember, "kari@example.com")
	detail = a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	kariMemberID, _ := memberOf(t, detail.JSON, "kari@example.com")["memberId"].(string)

	promote := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members/"+kariMemberID+"/role",
		cookie, map[string]any{"role": "admin"})
	if promote.Status != http.StatusOK {
		t.Fatalf("promote = %d %s, want 200", promote.Status, promote.Raw)
	}
	if entry := findAudit(t, a, "family.member.role"); entry.Detail != "kari@example.com: member → admin" {
		t.Errorf("family.member.role audit detail = %q", entry.Detail)
	}

	now := a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/members/"+adminMemberID, cookie, nil)
	if now.Status != http.StatusOK {
		t.Fatalf("removing the former last admin after promoting = %d %s, want 200", now.Status, now.Raw)
	}
	if entry := findAudit(t, a, "family.member.remove"); entry.Detail != "sysadmin@example.com" {
		t.Errorf("family.member.remove audit detail = %q", entry.Detail)
	}
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "organization_members" WHERE "organization_id" = $1 AND "user_id" = $2`,
		familyID, adminID); n != 0 {
		t.Errorf("the removed member is still in the family (%d rows)", n)
	}
}

// -----------------------------------------------------------------------
// Tenancy — the queries take family_id, and this is the test that keeps it
// that way
// -----------------------------------------------------------------------

func TestAdminFamilyRoutesAreScopedToTheFamilyInThePath(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")
	otherID, otherCookie := a.NewFamily("Berg", "other@example.com")
	otherUserID := userIDByEmail(t, a, "other@example.com")

	// Seed the OTHER family with an invite, a key and a member.
	otherInvite := a.Do(http.MethodPost, "/api/invites", otherCookie, nil)
	if otherInvite.Status != http.StatusCreated {
		t.Fatalf("seed other invite: %d %s", otherInvite.Status, otherInvite.Raw)
	}
	otherCode, _ := otherInvite.JSON["code"].(string)

	otherKey := a.Do(http.MethodPost, "/api/keys", otherCookie, map[string]any{"name": "theirs"})
	if otherKey.Status != http.StatusCreated {
		t.Fatalf("seed other key: %d %s", otherKey.Status, otherKey.Raw)
	}
	otherKeyID, _ := otherKey.JSON["id"].(string)

	otherDetail := a.Do(http.MethodGet, "/api/admin/families/"+otherID, cookie, nil)
	otherMemberID, _ := memberOf(t, otherDetail.JSON, "other@example.com")["memberId"].(string)

	// Every one of these names a real resource — of a DIFFERENT family than
	// the one in the path. All four must miss.
	cases := []struct {
		name, method, path string
		body               any
	}{
		{"invite", http.MethodDelete, "/api/admin/families/" + familyID + "/invites/" + otherCode, nil},
		{"key", http.MethodDelete, "/api/admin/families/" + familyID + "/keys/" + otherKeyID, nil},
		{"member removal", http.MethodDelete, "/api/admin/families/" + familyID + "/members/" + otherMemberID, nil},
		{"member role", http.MethodPost, "/api/admin/families/" + familyID + "/members/" + otherMemberID + "/role",
			map[string]any{"role": "member"}},
	}
	for _, c := range cases {
		res := a.Do(c.method, c.path, cookie, c.body)
		if res.Status != http.StatusNotFound {
			t.Errorf("%s of another family's resource = %d %s, want 404", c.name, res.Status, res.Raw)
		}
	}

	// And nothing was touched.
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "family_invite" WHERE "code" = $1 AND "revoked_at" IS NULL`, otherCode); n != 1 {
		t.Errorf("the other family's invite was revoked")
	}
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "api_key" WHERE "id" = $1 AND "revoked_at" IS NULL`, otherKeyID); n != 1 {
		t.Errorf("the other family's key was revoked")
	}
	if n := countRows(t, a,
		`SELECT COUNT(*) FROM "organization_members" WHERE "organization_id" = $1 AND "user_id" = $2`,
		otherID, otherUserID); n != 1 {
		t.Errorf("the other family's member was removed")
	}
	_ = adminID
}

// The happy paths of the two revocation routes, so the 404s above are known
// to be about scoping rather than about the routes not working at all.
func TestAdminRevokeFamilyInviteAndKey(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")

	minted := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/invites", cookie,
		map[string]any{"role": "member", "maxUses": 2})
	if minted.Status != http.StatusCreated {
		t.Fatalf("mint = %d %s, want 201", minted.Status, minted.Raw)
	}
	code, _ := minted.JSON["code"].(string)
	if minted.JSON["maxUses"] != float64(2) {
		t.Errorf("maxUses = %v, want 2 — the shared core should honour the body", minted.JSON["maxUses"])
	}
	if entry := findAudit(t, a, "family.invite.create"); entry.Detail != code+" member" {
		t.Errorf("family.invite.create audit detail = %q, want %q", entry.Detail, code+" member")
	}

	// Defaults still apply with no body at all, exactly as the family-admin
	// route behaves — the point of sharing one core.
	bare := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/invites", cookie, nil)
	if bare.Status != http.StatusCreated || bare.JSON["role"] != auth.RoleMember || bare.JSON["maxUses"] != float64(5) {
		t.Errorf("bare mint = %d %s, want 201 with role member and maxUses 5", bare.Status, bare.Raw)
	}

	revoked := a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/invites/"+code, cookie, nil)
	if revoked.Status != http.StatusOK {
		t.Fatalf("revoke invite = %d %s, want 200", revoked.Status, revoked.Raw)
	}
	if again := a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/invites/"+code, cookie, nil); again.Status != http.StatusNotFound {
		t.Errorf("revoking an already-revoked invite = %d, want 404", again.Status)
	}
	if entry := findAudit(t, a, "family.invite.revoke"); entry.AdminID != adminID || entry.Detail != code {
		t.Errorf("family.invite.revoke audit = %+v", entry)
	}

	key := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "grafana"})
	if key.Status != http.StatusCreated {
		t.Fatalf("seed key: %d %s", key.Status, key.Raw)
	}
	keyID, _ := key.JSON["id"].(string)

	killed := a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/keys/"+keyID, cookie, nil)
	if killed.Status != http.StatusOK {
		t.Fatalf("revoke key = %d %s, want 200", killed.Status, killed.Raw)
	}
	if n := countRows(t, a, `SELECT COUNT(*) FROM "api_key" WHERE "id" = $1 AND "revoked_at" IS NOT NULL`, keyID); n != 1 {
		t.Errorf("the key was not revoked")
	}
	if again := a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/keys/"+keyID, cookie, nil); again.Status != http.StatusNotFound {
		t.Errorf("revoking an already-revoked key = %d, want 404", again.Status)
	}
	findAudit(t, a, "family.key.revoke")
}

// Every mutation leaves a trail, attributed to the operator. Checked as a
// set rather than per-route so that adding a route without auditing it fails
// here even if its own test forgets.
func TestAdminFamilyMutationsAreAllAudited(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Ops")
	a.SignUp("Kari", "kari@example.com")

	created := a.Do(http.MethodPost, "/api/admin/families", cookie, map[string]any{
		"name": "Trail", "adminEmail": "kari@example.com",
	})
	familyID, _ := created.JSON["id"].(string)

	a.Do(http.MethodPatch, "/api/admin/families/"+familyID, cookie, map[string]any{"name": "Trail 2"})

	a.SignUp("Ola", "ola@example.com")
	a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members", cookie,
		map[string]any{"email": "ola@example.com", "role": "member"})

	detail := a.Do(http.MethodGet, "/api/admin/families/"+familyID, cookie, nil)
	olaMemberID, _ := memberOf(t, detail.JSON, "ola@example.com")["memberId"].(string)
	a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/members/"+olaMemberID+"/role",
		cookie, map[string]any{"role": "admin"})
	a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/members/"+olaMemberID, cookie, nil)

	minted := a.Do(http.MethodPost, "/api/admin/families/"+familyID+"/invites", cookie, nil)
	code, _ := minted.JSON["code"].(string)
	a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/invites/"+code, cookie, nil)

	key := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "k"})
	keyID, _ := key.JSON["id"].(string)
	a.Do(http.MethodDelete, "/api/admin/families/"+familyID+"/keys/"+keyID, cookie, nil)

	want := []string{
		"family.create",
		"family.rename",
		"family.member.add",
		"family.member.role",
		"family.member.remove",
		"family.invite.create",
		"family.invite.revoke",
		"family.key.revoke",
	}
	rows := auditRows(t, a)
	seen := map[string]bool{}
	for _, row := range rows {
		seen[row.Action] = true
		if row.AdminID != adminID {
			t.Errorf("audit row %+v attributed to %s, want the operator %s", row, row.AdminID, adminID)
		}
	}
	for _, action := range want {
		if !seen[action] {
			t.Errorf("no %q entry in the trail: %+v", action, rows)
		}
	}
	// The family-scoped actions all point at the family, so the trail can be
	// filtered by it later without a schema change.
	for _, row := range rows {
		if row.Action == "family.rename" || row.Action == "family.member.add" || row.Action == "family.key.revoke" {
			if row.Target != familyID {
				t.Errorf("%s target = %s, want the family id %s", row.Action, row.Target, familyID)
			}
		}
	}
}
