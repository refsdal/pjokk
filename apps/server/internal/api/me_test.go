package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// GET /api/me is NEW in Go (REF §A1, end of admin.ts): there is no TS route
// to port assertions from, so these tests exercise the shape and null
// semantics the route table spells out directly:
// {userId, name, email, role, familyId, memberRole, plan, impersonatedBy},
// with the last four null when the caller has no active family.

func TestGetMeAnonymousIsUnauthenticated(t *testing.T) {
	a := testrig.App(t)

	res := a.Do(http.MethodGet, "/api/me", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, body %s, want 401", res.Status, res.Raw)
	}
	if res.JSON["code"] != "UNAUTHENTICATED" {
		t.Errorf("code = %v, want UNAUTHENTICATED", res.JSON["code"])
	}
}

func TestGetMeWithNoActiveFamilyIsAllNulls(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["email"] != "solo@example.com" {
		t.Errorf("email = %v, want solo@example.com", res.JSON["email"])
	}
	if res.JSON["name"] != "Solo" {
		t.Errorf("name = %v, want Solo", res.JSON["name"])
	}
	for _, field := range []string{"familyId", "memberRole", "plan", "role", "impersonatedBy"} {
		if v, ok := res.JSON[field]; ok && v != nil {
			t.Errorf("%s = %v, want null", field, v)
		}
	}
}

func TestGetMeWithActiveFamily(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["familyId"] != familyID {
		t.Errorf("familyId = %v, want %q", res.JSON["familyId"], familyID)
	}
	if res.JSON["memberRole"] != "admin" {
		t.Errorf("memberRole = %v, want admin (the family's creator)", res.JSON["memberRole"])
	}
	if res.JSON["plan"] != "free" {
		t.Errorf("plan = %v, want free", res.JSON["plan"])
	}
	if v, ok := res.JSON["impersonatedBy"]; ok && v != nil {
		t.Errorf("impersonatedBy = %v, want null (not impersonating)", v)
	}
}
