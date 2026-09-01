package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Babies — ports apps/api/test/household.test.ts's "multiple babies per
// household" describe block and apps/api/test/api-keys.test.ts's "baby sex"
// block. The 402 multipleBabies gate those TS tests worked around
// (setPlan(..., "premium")) is gone in Go (REF §A1: "free — no plan gate"),
// so the Go port needs no plan setup at all.
// -----------------------------------------------------------------------

func TestListBabiesEmptyFamily(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if len(res.JSON) != 0 {
		t.Fatalf("JSON = %v, want an empty array", res.JSON)
	}
}

func TestCreateBabyIsFreeAndListsOldestFirst(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	nora := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPost, "/api/babies", cookie, map[string]any{
		"name":      "Emil",
		"birthDate": "2024-01-15T00:00:00Z",
		"sex":       "boy",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("POST /api/babies status = %d, body %s (multipleBabies is free in Go, REF §A1)", res.Status, res.Raw)
	}
	emilID, _ := res.JSON["id"].(string)
	if emilID == "" {
		t.Fatalf("created baby has no id: %v", res.JSON)
	}
	if res.JSON["sex"] != "boy" {
		t.Errorf("created baby sex = %v, want boy", res.JSON["sex"])
	}

	list := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	if list.Status != http.StatusOK {
		t.Fatalf("GET /api/babies status = %d, body %s", list.Status, list.Raw)
	}
	if len(list.JSON) != 2 {
		t.Fatalf("GET /api/babies = %v, want 2 babies", list.JSON)
	}
	first := list.JSON[0].(map[string]any)
	second := list.JSON[1].(map[string]any)
	if first["id"] != nora {
		t.Errorf("first baby = %v, want %q (oldest first)", first["id"], nora)
	}
	if second["id"] != emilID {
		t.Errorf("second baby = %v, want %q", second["id"], emilID)
	}
	if first["sex"] != nil {
		t.Errorf("Nora's sex = %v, want null (never set)", first["sex"])
	}
}

func TestDeleteBabyRequiresAdminAndCascadesLogs(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Doomed baby")

	var caretakerID string
	if err := a.Rig.Pool.QueryRow(ctx,
		`SELECT "user_id" FROM "organization_members" WHERE "organization_id" = $1 LIMIT 1`, familyID,
	).Scan(&caretakerID); err != nil {
		t.Fatalf("find the admin's user id: %v", err)
	}
	if _, err := a.Rig.Pool.Exec(ctx, `
		INSERT INTO "feed_log" ("family_id", "baby_id", "caretaker_id", "time", "type", "amount_ml")
		VALUES ($1, $2, $3, now(), 'bottle', 50)`,
		familyID, babyID, caretakerID); err != nil {
		t.Fatalf("seed feed_log: %v", err)
	}

	memberID := a.SignUp("Plain member", "member@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "member@example.com")

	forbidden := a.Do(http.MethodDelete, "/api/babies/"+babyID, memberCookie, nil)
	if forbidden.Status != http.StatusForbidden {
		t.Fatalf("member DELETE status = %d, body %s, want 403", forbidden.Status, forbidden.Raw)
	}
	if forbidden.JSON["error"] != "Admin only" || forbidden.JSON["code"] != "FORBIDDEN" {
		t.Errorf("member DELETE body = %v, want {error:\"Admin only\",code:\"FORBIDDEN\"}", forbidden.JSON)
	}

	ok := a.Do(http.MethodDelete, "/api/babies/"+babyID, adminCookie, nil)
	if ok.Status != http.StatusOK {
		t.Fatalf("admin DELETE status = %d, body %s, want 200", ok.Status, ok.Raw)
	}
	if ok.JSON["ok"] != true {
		t.Errorf("admin DELETE body = %v, want {ok:true}", ok.JSON)
	}

	var count int
	if err := a.Rig.Pool.QueryRow(ctx, `SELECT COUNT(*)::int FROM "feed_log" WHERE "baby_id" = $1`, babyID).Scan(&count); err != nil {
		t.Fatalf("count feed_log after delete: %v", err)
	}
	if count != 0 {
		t.Errorf("feed_log rows after cascade delete = %d, want 0", count)
	}
}

func TestDeleteBabyUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodDelete, "/api/babies/does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestUpdateBabyEmptyPatchIsANoOp(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPatch, "/api/babies/"+babyID, cookie, map[string]any{})
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Nora" {
		t.Errorf("name after an empty PATCH = %v, want unchanged \"Nora\"", res.JSON["name"])
	}
	if res.JSON["id"] != babyID {
		t.Errorf("id = %v, want %q", res.JSON["id"], babyID)
	}
}

// Ports apps/api/test/api-keys.test.ts's "baby sex" describe block.
func TestUpdateBabyPatchesSexAndReflectsInList(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	patch := a.Do(http.MethodPatch, "/api/babies/"+babyID, cookie, map[string]any{"sex": "girl"})
	if patch.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", patch.Status, patch.Raw)
	}
	if patch.JSON["sex"] != "girl" {
		t.Errorf("PATCH response sex = %v, want girl", patch.JSON["sex"])
	}

	list := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	row := list.JSON[0].(map[string]any)
	if row["sex"] != "girl" {
		t.Errorf("GET /api/babies[0].sex = %v, want girl", row["sex"])
	}
}

func TestUpdateBabyUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPatch, "/api/babies/does-not-exist", cookie, map[string]any{"name": "X"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

// -----------------------------------------------------------------------
// Family / members — ports apps/api/test/household.test.ts's "household
// member management" describe block. The TS version drove better-auth's own
// organization.update-member-role/remove-member routes directly; the Go
// surface is the NEW /api/family/members/{memberId}[/role] pair (REF §A1,
// end of admin.ts), so these tests exercise those instead, keeping the same
// scenarios: list shape, admin promotes/removes, removed member loses
// access, plain members are refused.
// -----------------------------------------------------------------------

func TestGetFamilyShape(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/family", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Hansen" {
		t.Errorf("name = %v, want Hansen", res.JSON["name"])
	}
	if res.JSON["plan"] != "free" {
		t.Errorf("plan = %v, want free", res.JSON["plan"])
	}
	if s, _ := res.JSON["slug"].(string); s == "" {
		t.Errorf("slug = %v, want non-empty", res.JSON["slug"])
	}
}

func TestListFamilyMembersShape(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.DoArray(http.MethodGet, "/api/family/members", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if len(res.JSON) != 1 {
		t.Fatalf("members = %v, want 1 (the creator)", res.JSON)
	}
	row := res.JSON[0].(map[string]any)
	if id, _ := row["memberId"].(string); id == "" {
		t.Errorf("memberId = %v, want non-empty", row["memberId"])
	}
	if row["role"] != "admin" {
		t.Errorf("role = %v, want admin", row["role"])
	}
	if row["email"] != "parent@example.com" {
		t.Errorf("email = %v, want parent@example.com", row["email"])
	}
}

func TestFamilyAdminChangesRoleAndRemovesMember(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")

	otherID := a.SignUp("Removable", "removable@example.com")
	otherCookie := a.AddMember(familyID, otherID, auth.RoleMember, "removable@example.com")

	if res := a.Do(http.MethodGet, "/api/babies", otherCookie, nil); res.Status != http.StatusOK {
		t.Fatalf("new member GET /api/babies status = %d, body %s, want 200", res.Status, res.Raw)
	}

	members := a.DoArray(http.MethodGet, "/api/family/members", adminCookie, nil)
	var targetMemberID string
	for _, row := range members.JSON {
		m := row.(map[string]any)
		if m["userId"] == otherID {
			targetMemberID, _ = m["memberId"].(string)
		}
	}
	if targetMemberID == "" {
		t.Fatalf("did not find the added member in %v", members.JSON)
	}

	promote := a.Do(http.MethodPost, "/api/family/members/"+targetMemberID+"/role", adminCookie,
		map[string]any{"role": "admin"})
	if promote.Status != http.StatusOK || promote.JSON["ok"] != true {
		t.Fatalf("promote status = %d body = %v, want 200 {ok:true}", promote.Status, promote.JSON)
	}

	remove := a.Do(http.MethodDelete, "/api/family/members/"+targetMemberID, adminCookie, nil)
	if remove.Status != http.StatusOK || remove.JSON["ok"] != true {
		t.Fatalf("remove status = %d body = %v, want 200 {ok:true}", remove.Status, remove.JSON)
	}

	// The removed member's existing session claims no longer grant
	// anything: RequireFamily's membership-row check (not the session's
	// stale active_organization_id) is what "member" means.
	denied := a.Do(http.MethodGet, "/api/babies", otherCookie, nil)
	if denied.Status != http.StatusForbidden {
		t.Errorf("removed member GET /api/babies status = %d, want 403", denied.Status)
	}
}

func TestPlainMembersCannotManageMembership(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")

	malloryID := a.SignUp("Mallory member", "mallory@example.com")
	malloryCookie := a.AddMember(familyID, malloryID, auth.RoleMember, "mallory@example.com")

	members := a.DoArray(http.MethodGet, "/api/family/members", adminCookie, nil)
	var adminMemberID string
	for _, row := range members.JSON {
		m := row.(map[string]any)
		if m["userId"] != malloryID {
			adminMemberID, _ = m["memberId"].(string)
		}
	}
	if adminMemberID == "" {
		t.Fatalf("did not find the admin member in %v", members.JSON)
	}

	res := a.Do(http.MethodDelete, "/api/family/members/"+adminMemberID, malloryCookie, nil)
	if res.Status != http.StatusForbidden {
		t.Fatalf("plain member DELETE status = %d, body %s, want 403", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Admin only" || res.JSON["code"] != "FORBIDDEN" {
		t.Errorf("body = %v, want {error:\"Admin only\",code:\"FORBIDDEN\"}", res.JSON)
	}
}

func TestSetMemberRoleUnknownMemberIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/family/members/does-not-exist/role", cookie, map[string]any{"role": "admin"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestDeleteFamilyMemberUnknownMemberIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodDelete, "/api/family/members/does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}
