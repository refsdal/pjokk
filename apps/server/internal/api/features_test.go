package api_test

import (
	"net/http"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): a
// `features` array on every Baby, all thirteen for a baby that predates
// the column (testrig.NewBaby mirrors the backfill), none for a baby
// created over the API — she chooses second, on the carousel.

func TestBabyFeaturesDefaultEmptyOverTheAPI(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	res := a.Do(http.MethodPost, "/api/babies", cookie, map[string]any{
		"name": "Emil", "birthDate": "2026-06-15T00:00:00Z",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("POST /api/babies = %d %s", res.Status, res.Raw)
	}
	features, ok := res.JSON["features"].([]any)
	if !ok || len(features) != 0 {
		t.Fatalf("features = %v, want []", res.JSON["features"])
	}
}

func TestSeededBabyTracksEverything(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	a.NewBaby(familyID, "Nora")
	list := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	baby := list.JSON[0].(map[string]any)
	features, _ := baby["features"].([]any)
	if len(features) != len(api.AllFeatures) {
		t.Fatalf("features = %v, want all %d", features, len(api.AllFeatures))
	}
	for i, f := range api.AllFeatures {
		if features[i] != f {
			t.Errorf("features[%d] = %v, want %q", i, features[i], f)
		}
	}
}

func TestAllFeaturesMatchTheSpec(t *testing.T) {
	t.Parallel()
	doc, err := openapi3.NewLoader().LoadFromData(api.SpecYAML)
	if err != nil {
		t.Fatal(err)
	}
	enum := doc.Components.Schemas["Feature"].Value.Enum
	if len(enum) != len(api.AllFeatures) {
		t.Fatalf("spec enum %v, AllFeatures %v", enum, api.AllFeatures)
	}
	for i, v := range enum {
		if v != api.AllFeatures[i] {
			t.Errorf("enum[%d] = %v, AllFeatures[%d] = %q", i, v, i, api.AllFeatures[i])
		}
	}
}

func TestSetBabyFeaturesReplacesTheSetInSpecOrder(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", cookie, map[string]any{
		"features": []string{"diapers", "sleep", "sleep", "feeds"},
	})
	if res.Status != http.StatusOK {
		t.Fatalf("PUT = %d %s", res.Status, res.Raw)
	}
	got, _ := res.JSON["features"].([]any)
	if len(got) != 3 || got[0] != "feeds" || got[1] != "sleep" || got[2] != "diapers" {
		t.Fatalf("features = %v, want [feeds sleep diapers] (deduped, spec order)", got)
	}

	list := a.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	if f, _ := list.JSON[0].(map[string]any)["features"].([]any); len(f) != 3 {
		t.Errorf("GET /api/babies features = %v, want the three", f)
	}

	empty := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", cookie, map[string]any{"features": []string{}})
	if f, _ := empty.JSON["features"].([]any); empty.Status != http.StatusOK || len(f) != 0 {
		t.Errorf("PUT [] = %d %v, want 200 []", empty.Status, empty.JSON["features"])
	}
}

func TestSetBabyFeaturesIsAdminOnlyAndValidated(t *testing.T) {
	t.Parallel()
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	memberID := a.SignUp("Plain member", "member@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "member@example.com")

	forbidden := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", memberCookie, map[string]any{"features": []string{"sleep"}})
	if forbidden.Status != http.StatusForbidden || forbidden.JSON["code"] != "FORBIDDEN" {
		t.Errorf("member PUT = %d %v, want 403 FORBIDDEN", forbidden.Status, forbidden.JSON)
	}

	bad := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", adminCookie, map[string]any{"features": []string{"sleep", "unicorns"}})
	if bad.Status != http.StatusBadRequest || bad.JSON["code"] != "VALIDATION" {
		t.Errorf("unknown key PUT = %d %v, want 400 VALIDATION", bad.Status, bad.JSON)
	}

	_, otherCookie := a.NewFamily("Olsen", "other@example.com")
	missing := a.Do(http.MethodPut, "/api/babies/"+babyID+"/features", otherCookie, map[string]any{"features": []string{"sleep"}})
	if missing.Status != http.StatusNotFound {
		t.Errorf("other family's PUT = %d %s, want 404", missing.Status, missing.Raw)
	}
}
