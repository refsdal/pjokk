package api_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Ports apps/api/test/feedback-batch.test.ts's "custom sleep locations"
// describe block.

func TestSleepLocationsMemberReadsOnlyAdminWritesFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/sleep-locations", adminCookie, map[string]any{"name": "Hammock"})
	if created.Status != http.StatusCreated {
		t.Fatalf("admin POST status = %d, body %s", created.Status, created.Raw)
	}

	memberID := a.SignUp("Reader", "reader@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "reader@example.com")

	list := a.DoArray(http.MethodGet, "/api/sleep-locations", memberCookie, nil)
	if list.Status != http.StatusOK {
		t.Fatalf("member GET status = %d, body %s", list.Status, list.Raw)
	}
	found := false
	for _, row := range list.JSON {
		if row.(map[string]any)["name"] == "Hammock" {
			found = true
		}
	}
	if !found {
		t.Errorf("member GET list = %v, want to contain %q", list.JSON, "Hammock")
	}

	memberCreate := a.Do(http.MethodPost, "/api/sleep-locations", memberCookie, map[string]any{"name": "Nope"})
	if memberCreate.Status != http.StatusForbidden {
		t.Fatalf("member POST status = %d, body %s, want 403", memberCreate.Status, memberCreate.Raw)
	}
	if memberCreate.JSON["error"] != "Admin only" || memberCreate.JSON["code"] != "FORBIDDEN" {
		t.Errorf("member POST body = %v, want {error:\"Admin only\",code:\"FORBIDDEN\"}", memberCreate.JSON)
	}

	_, cookieB := a.NewFamily("Other family", "b@example.com")
	otherList := a.DoArray(http.MethodGet, "/api/sleep-locations", cookieB, nil)
	if len(otherList.JSON) != 0 {
		t.Errorf("other family's list = %v, want empty (family-scoped)", otherList.JSON)
	}
}

func TestSleepLocationsRejectsDuplicateNamesIncludingDefaults(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/sleep-locations", cookie, map[string]any{"name": "crib"})
	if res.Status != http.StatusConflict {
		t.Fatalf("status = %d, body %s, want 409", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Duplicate name" || res.JSON["code"] != "DUPLICATE" {
		t.Errorf("body = %v, want {error:\"Duplicate name\",code:\"DUPLICATE\"}", res.JSON)
	}

	// Case-insensitive against an existing CUSTOM name too, not just the
	// defaults.
	first := a.Do(http.MethodPost, "/api/sleep-locations", cookie, map[string]any{"name": "Hammock"})
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	dup := a.Do(http.MethodPost, "/api/sleep-locations", cookie, map[string]any{"name": "hammock"})
	if dup.Status != http.StatusConflict {
		t.Fatalf("case-insensitive dup status = %d, body %s, want 409", dup.Status, dup.Raw)
	}
	if dup.JSON["code"] != "DUPLICATE" {
		t.Errorf("code = %v, want DUPLICATE", dup.JSON["code"])
	}
}

func TestSleepLocationsEnforcesCapAt20Custom(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	for i := 0; i < 20; i++ {
		res := a.Do(http.MethodPost, "/api/sleep-locations", cookie, map[string]any{"name": fmt.Sprintf("Spot %d", i)})
		if res.Status != http.StatusCreated {
			t.Fatalf("POST #%d status = %d, body %s", i, res.Status, res.Raw)
		}
	}

	overCap := a.Do(http.MethodPost, "/api/sleep-locations", cookie, map[string]any{"name": "One too many"})
	if overCap.Status != http.StatusConflict {
		t.Fatalf("status = %d, body %s, want 409", overCap.Status, overCap.Raw)
	}
	if overCap.JSON["code"] != "LIMIT_REACHED" {
		t.Errorf("code = %v, want LIMIT_REACHED", overCap.JSON["code"])
	}
}

func TestSleepLocationsMemberDeleteForbiddenAdminDeleteRemovesUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/sleep-locations", adminCookie, map[string]any{"name": "Hammock"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	memberID := a.SignUp("Reader", "reader@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "reader@example.com")

	memberDelete := a.Do(http.MethodDelete, "/api/sleep-locations/"+id, memberCookie, nil)
	if memberDelete.Status != http.StatusForbidden {
		t.Fatalf("member DELETE status = %d, body %s, want 403", memberDelete.Status, memberDelete.Raw)
	}

	del := a.Do(http.MethodDelete, "/api/sleep-locations/"+id, adminCookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("admin DELETE status = %d, body %s", del.Status, del.Raw)
	}
	if del.JSON["ok"] != true {
		t.Errorf("admin DELETE body = %v, want {ok:true}", del.JSON)
	}

	list := a.DoArray(http.MethodGet, "/api/sleep-locations", adminCookie, nil)
	for _, row := range list.JSON {
		if row.(map[string]any)["id"] == id {
			t.Errorf("list after delete still contains %q", id)
		}
	}

	again := a.Do(http.MethodDelete, "/api/sleep-locations/"+id, adminCookie, nil)
	if again.Status != http.StatusNotFound {
		t.Fatalf("second DELETE status = %d, body %s, want 404", again.Status, again.Raw)
	}
}
