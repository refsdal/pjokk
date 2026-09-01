package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Contacts — ports apps/api/test/contacts.test.ts's "contact scoped
// helpers" and "contacts API" describe blocks. The TS predecessor
// soft-locked creation behind premium (402 PLAN_REQUIRED); this Go port
// removes that gate entirely (see internal/api/contacts.go's package doc
// comment), so the 402-vs-premium test is replaced by
// TestCreateContactIsFreeFullCRUD below.
// -----------------------------------------------------------------------

func TestCreateContactWithBabyLinkHydrates(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":    "Dr. Hansen",
		"role":    "doctor",
		"icon":    "doctor",
		"phone":   "+47 22 00 00 00",
		"email":   "hansen@legesenteret.no",
		"website": "legesenteret.no",
		"notes":   "Fastlege",
		"babyIds": []string{babyID},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "Dr. Hansen" {
		t.Errorf("name = %v, want %q", res.JSON["name"], "Dr. Hansen")
	}
	if res.JSON["icon"] != "doctor" {
		t.Errorf("icon = %v, want %q", res.JSON["icon"], "doctor")
	}
	babies, _ := res.JSON["babies"].([]any)
	if len(babies) != 1 || babies[0].(map[string]any)["id"] != babyID {
		t.Errorf("babies = %v, want one entry for %q", babies, babyID)
	}
}

func TestCreateContactZeroBabiesIsFamilyWide(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{"name": "Mormor"})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	babies, _ := res.JSON["babies"].([]any)
	if len(babies) != 0 {
		t.Errorf("babies = %v, want empty (family-wide)", babies)
	}
	if res.JSON["role"] != nil {
		t.Errorf("role = %v, want nil", res.JSON["role"])
	}
}

func TestCreateContactSharedAcrossSeveralBabies(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	siblingID := a.NewBaby(familyID, "Sibling")

	res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":    "Dr. Hansen",
		"babyIds": []string{babyID, siblingID},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	babies, _ := res.JSON["babies"].([]any)
	if len(babies) != 2 {
		t.Errorf("babies = %v, want 2", babies)
	}
}

func TestListContactsByNameFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	_, otherCookie := a.NewFamily("Other family", "stranger@example.com")

	for _, name := range []string{"Zita", "Anna"} {
		if res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{"name": name}); res.Status != http.StatusCreated {
			t.Fatalf("create %q status = %d, body %s", name, res.Status, res.Raw)
		}
	}
	if res := a.Do(http.MethodPost, "/api/contacts", otherCookie, map[string]any{"name": "Not ours"}); res.Status != http.StatusCreated {
		t.Fatalf("other family create status = %d, body %s", res.Status, res.Raw)
	}

	listed := a.DoArray(http.MethodGet, "/api/contacts", cookie, nil)
	if listed.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", listed.Status, listed.Raw)
	}
	if len(listed.JSON) != 2 {
		t.Fatalf("listed = %v, want 2 contacts", listed.JSON)
	}
	if listed.JSON[0].(map[string]any)["name"] != "Anna" || listed.JSON[1].(map[string]any)["name"] != "Zita" {
		t.Errorf("listed names = %v, want [Anna Zita]", listed.JSON)
	}
}

func TestUpdateContactReplacesLinkSetOmittedUntouched(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	siblingID := a.NewBaby(familyID, "Sibling")

	created := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":    "Mormor",
		"babyIds": []string{babyID},
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	relinked := a.Do(http.MethodPatch, "/api/contacts/"+id, cookie, map[string]any{"babyIds": []string{siblingID}})
	if relinked.Status != http.StatusOK {
		t.Fatalf("relink status = %d, body %s", relinked.Status, relinked.Raw)
	}
	babies, _ := relinked.JSON["babies"].([]any)
	if len(babies) != 1 || babies[0].(map[string]any)["id"] != siblingID {
		t.Errorf("babies after relink = %v, want one entry for %q", babies, siblingID)
	}

	renamed := a.Do(http.MethodPatch, "/api/contacts/"+id, cookie, map[string]any{"name": "Farmor"})
	if renamed.Status != http.StatusOK {
		t.Fatalf("rename status = %d, body %s", renamed.Status, renamed.Raw)
	}
	if renamed.JSON["name"] != "Farmor" {
		t.Errorf("name = %v, want %q", renamed.JSON["name"], "Farmor")
	}
	babiesAfterRename, _ := renamed.JSON["babies"].([]any)
	if len(babiesAfterRename) != 1 || babiesAfterRename[0].(map[string]any)["id"] != siblingID {
		t.Errorf("babies after unrelated rename = %v, want still one entry for %q (untouched)", babiesAfterRename, siblingID)
	}

	unlinked := a.Do(http.MethodPatch, "/api/contacts/"+id, cookie, map[string]any{"babyIds": []string{}})
	if unlinked.Status != http.StatusOK {
		t.Fatalf("unlink status = %d, body %s", unlinked.Status, unlinked.Raw)
	}
	babiesAfterUnlink, _ := unlinked.JSON["babies"].([]any)
	if len(babiesAfterUnlink) != 0 {
		t.Errorf("babies after empty-array PATCH = %v, want empty", babiesAfterUnlink)
	}
}

func TestContactCrossFamilyUpdateDeleteIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	created := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{"name": "Ours"})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	_, otherCookie := a.NewFamily("Other family", "stranger@example.com")
	hijack := a.Do(http.MethodPatch, "/api/contacts/"+id, otherCookie, map[string]any{"name": "Hijacked"})
	if hijack.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", hijack.Status)
	}
	del := a.Do(http.MethodDelete, "/api/contacts/"+id, otherCookie, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
	// Still ours — the refusal deleted nothing.
	listed := a.DoArray(http.MethodGet, "/api/contacts", cookie, nil)
	if len(listed.JSON) != 1 {
		t.Errorf("listed after refused cross-family delete = %v, want 1", listed.JSON)
	}
}

// TestCreateContactIsFreeFullCRUD replaces the TS predecessor's
// 402-then-premium test: creation needs no plan at all on this port, and
// read/edit/delete were always open.
func TestCreateContactIsFreeFullCRUD(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":    "Dr. Hansen",
		"role":    "doctor",
		"babyIds": []string{babyID},
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s, want 201 (free — no plan gate)", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)
	babies, _ := created.JSON["babies"].([]any)
	if len(babies) != 1 || babies[0].(map[string]any)["id"] != babyID {
		t.Errorf("babies = %v, want one entry for %q", babies, babyID)
	}

	listed := a.DoArray(http.MethodGet, "/api/contacts", cookie, nil)
	if listed.Status != http.StatusOK || len(listed.JSON) != 1 {
		t.Fatalf("list status = %d, len = %d, body %s", listed.Status, len(listed.JSON), listed.Raw)
	}

	edited := a.Do(http.MethodPatch, "/api/contacts/"+id, cookie, map[string]any{"phone": "+47 22 00 00 00"})
	if edited.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", edited.Status, edited.Raw)
	}
	if edited.JSON["phone"] != "+47 22 00 00 00" {
		t.Errorf("phone = %v, want %q", edited.JSON["phone"], "+47 22 00 00 00")
	}

	removed := a.Do(http.MethodDelete, "/api/contacts/"+id, cookie, nil)
	if removed.Status != http.StatusOK {
		t.Errorf("DELETE status = %d, want 200", removed.Status)
	}
}

func TestCreateContactRejectsForeignBabyId(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	familyB, _ := a.NewFamily("Other family", "other@example.com")
	theirBabyID := a.NewBaby(familyB, "Their baby")

	res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":    "Sneaky",
		"babyIds": []string{theirBabyID},
	})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s, want 400", res.Status, res.Raw)
	}
	if res.JSON["code"] != "INVALID_REFERENCE" {
		t.Errorf("code = %v, want INVALID_REFERENCE", res.JSON["code"])
	}
}

func TestUpdateContactRejectsForeignBabyId(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	created := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{"name": "Mormor"})
	if created.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	familyB, _ := a.NewFamily("Other family", "other@example.com")
	theirBabyID := a.NewBaby(familyB, "Their baby")

	res := a.Do(http.MethodPatch, "/api/contacts/"+id, cookie, map[string]any{"babyIds": []string{theirBabyID}})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s, want 400", res.Status, res.Raw)
	}
	if res.JSON["code"] != "INVALID_REFERENCE" {
		t.Errorf("code = %v, want INVALID_REFERENCE", res.JSON["code"])
	}
}

func TestContactsNeverLeakAcrossFamilies(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	if res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{"name": "Ours"}); res.Status != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", res.Status, res.Raw)
	}

	_, otherCookie := a.NewFamily("Other family", "outsider@example.com")
	listed := a.DoArray(http.MethodGet, "/api/contacts", otherCookie, nil)
	if listed.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", listed.Status, listed.Raw)
	}
	if len(listed.JSON) != 0 {
		t.Errorf("listed = %v, want empty (another family's contacts must not leak)", listed.JSON)
	}
}

func TestCreateContactDedupesRepeatedBabyIds(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":    "Mormor",
		"babyIds": []string{babyID, babyID},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	babies, _ := res.JSON["babies"].([]any)
	if len(babies) != 1 {
		t.Errorf("babies = %v, want deduped to 1", babies)
	}
}

func TestCreateContactBadEmailIs400AndUnknownIdIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	bad := a.Do(http.MethodPost, "/api/contacts", cookie, map[string]any{
		"name":  "Nope",
		"email": "not-an-email",
	})
	if bad.Status != http.StatusBadRequest {
		t.Errorf("bad email status = %d, want 400", bad.Status)
	}

	missing := a.Do(http.MethodPatch, "/api/contacts/does-not-exist", cookie, map[string]any{"name": "Ghost"})
	if missing.Status != http.StatusNotFound {
		t.Errorf("unknown id PATCH status = %d, want 404", missing.Status)
	}
}
