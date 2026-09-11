package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// GET /api/me is NEW in Go: there is no TS route
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

// The version the SPA shows under Settings is the binary's own build
// version (internal/buildinfo), handed in through Deps like every other
// collaborator — the same string GoReleaser tags the image with, so the
// footer, the image tag and (later) OpenTelemetry's service.version can
// never drift apart.
func TestGetMeCarriesBuildVersion(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["version"] != testrig.Version {
		t.Errorf("version = %v, want %q (what the rig put in Deps)", res.JSON["version"], testrig.Version)
	}
}

func TestGetMeCarriesProfileFields(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo Person", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["displayName"] != "Solo Person" {
		t.Errorf("displayName = %v, want the full name", res.JSON["displayName"])
	}
	for _, field := range []string{"nickname", "phone", "avatarUrl"} {
		if v, ok := res.JSON[field]; !ok || v != nil {
			t.Errorf("%s = %v (present %v), want an explicit null", field, v, ok)
		}
	}
}

func TestUpdateMeEditsTheProfile(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo Person", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{
		"name":     "  Anders Olsen ",
		"nickname": "Pappa",
		"phone":    "+47 900 00 000",
	})
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Anders Olsen" {
		t.Errorf("name = %v, want trimmed", res.JSON["name"])
	}
	if res.JSON["displayName"] != "Pappa" || res.JSON["nickname"] != "Pappa" {
		t.Errorf("displayName/nickname = %v/%v, want Pappa", res.JSON["displayName"], res.JSON["nickname"])
	}
	if res.JSON["phone"] != "+47 900 00 000" {
		t.Errorf("phone = %v", res.JSON["phone"])
	}

	// null clears; an absent key leaves the field alone.
	res = a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"nickname": nil})
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if v := res.JSON["nickname"]; v != nil {
		t.Errorf("nickname after null = %v, want null", v)
	}
	if res.JSON["displayName"] != "Anders Olsen" {
		t.Errorf("displayName after clearing nickname = %v, want the full name", res.JSON["displayName"])
	}
	if res.JSON["phone"] != "+47 900 00 000" {
		t.Errorf("phone was touched by a patch that omitted it: %v", res.JSON["phone"])
	}

	// The session's own name follows the edit too.
	res = a.Do(http.MethodGet, "/api/me", cookie, nil)
	if res.JSON["name"] != "Anders Olsen" {
		t.Errorf("GET name = %v, want the edited name", res.JSON["name"])
	}
}

func TestUpdateMeRejectsBadInput(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo Person", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	cases := []struct {
		name string
		body map[string]any
	}{
		{"blank name", map[string]any{"name": "   "}},
		{"nickname over 40 chars", map[string]any{"nickname": strings.Repeat("x", 41)}},
		{"phone with letters", map[string]any{"phone": "call me"}},
		{"phone over 32 chars", map[string]any{"phone": strings.Repeat("1", 33)}},
	}
	for _, tc := range cases {
		res := a.Do(http.MethodPatch, "/api/me", cookie, tc.body)
		if res.Status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, body %s, want 400", tc.name, res.Status, res.Raw)
		}
		if res.JSON["code"] != "VALIDATION" {
			t.Errorf("%s: code = %v, want VALIDATION", tc.name, res.JSON["code"])
		}
	}
}

func TestUpdateMeRequiresASession(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodPatch, "/api/me", "", map[string]any{"name": "x"})
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}
