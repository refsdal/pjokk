package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// The medicine catalogue (issue #49): a family's own list of medicines with
// a usual dose and a minimum interval, and the dose log's link to it.
// -----------------------------------------------------------------------

func TestMedicineCatalogueCrudAndDoseLink(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	if list := a.DoArray(http.MethodGet, "/api/medicines", cookie, nil); list.Status != http.StatusOK || len(list.JSON) != 0 {
		t.Fatalf("initial list = %d %s", list.Status, list.Raw)
	}

	created := a.Do(http.MethodPost, "/api/medicines", cookie, map[string]any{
		"name": "  Paracetamol ", "defaultAmount": 2.5, "unit": "ml", "minIntervalMin": 360,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Status, created.Raw)
	}
	if created.JSON["name"] != "Paracetamol" || created.JSON["defaultAmount"] != 2.5 || created.JSON["unit"] != "ml" || created.JSON["minIntervalMin"] != float64(360) || created.JSON["isSupplement"] != false || created.JSON["archived"] != false || created.JSON["lastDoseAt"] != nil {
		t.Errorf("created = %v", created.JSON)
	}
	id, _ := created.JSON["id"].(string)

	if res := a.Do(http.MethodPost, "/api/medicines", cookie, map[string]any{"name": "   "}); res.Status != http.StatusBadRequest {
		t.Errorf("blank name = %d, want 400", res.Status)
	}
	vitamin := a.Do(http.MethodPost, "/api/medicines", cookie, map[string]any{"name": "Vitamin D", "unit": "drops", "defaultAmount": 5, "isSupplement": true})
	if vitamin.JSON["isSupplement"] != true {
		t.Errorf("vitamin = %v, want isSupplement true", vitamin.JSON)
	}

	// A dose linked to the entry: the id is stored and echoed, and the
	// catalogue's lastDoseAt follows — per baby when asked.
	t0 := time.Date(2026, 3, 16, 9, 0, 0, 0, time.UTC)
	dose := a.Do(http.MethodPost, "/api/medicine", cookie, map[string]any{
		"babyId": babyID, "time": t0.Format(time.RFC3339), "name": "Paracetamol", "amount": 2.5, "unit": "ml", "medicineId": id,
	})
	if dose.Status != http.StatusCreated || dose.JSON["medicineId"] != id {
		t.Fatalf("dose = %d %s, want 201 with medicineId", dose.Status, dose.Raw)
	}
	list := a.DoArray(http.MethodGet, "/api/medicines?babyId="+babyID, cookie, nil)
	first, _ := list.JSON[0].(map[string]any)
	if first["name"] != "Paracetamol" || first["lastDoseAt"] != t0.Format(time.RFC3339) {
		t.Errorf("list[0] = %v, want Paracetamol with lastDoseAt %s", first, t0.Format(time.RFC3339))
	}
	other := a.NewBaby(familyID, "Ola")
	otherList := a.DoArray(http.MethodGet, "/api/medicines?babyId="+other, cookie, nil)
	if o, _ := otherList.JSON[0].(map[string]any); o["lastDoseAt"] != nil {
		t.Errorf("the other baby's lastDoseAt = %v, want null", o["lastDoseAt"])
	}

	// The dose log lists the link and the timeline carries it.
	doses := a.DoArray(http.MethodGet, "/api/medicine?babyId="+babyID, cookie, nil)
	if row, _ := doses.JSON[0].(map[string]any); row["medicineId"] != id {
		t.Errorf("dose list medicineId = %v, want %s", row["medicineId"], id)
	}
	tl := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID+"&filter=other", cookie, nil)
	entries, _ := tl.JSON["entries"].([]any)
	if e, _ := entries[0].(map[string]any); e["medicineId"] != id {
		t.Errorf("timeline medicineId = %v, want %s", e["medicineId"], id)
	}

	// PATCH: tri-state on the entry; archive sorts it last and flags it.
	patched := a.Do(http.MethodPatch, "/api/medicines/"+id, cookie, map[string]any{"minIntervalMin": nil, "defaultAmount": 5, "archived": true})
	if patched.Status != http.StatusOK || patched.JSON["minIntervalMin"] != nil || patched.JSON["defaultAmount"] != float64(5) || patched.JSON["archived"] != true {
		t.Errorf("patched = %d %v", patched.Status, patched.JSON)
	}
	sorted := a.DoArray(http.MethodGet, "/api/medicines", cookie, nil)
	if last, _ := sorted.JSON[len(sorted.JSON)-1].(map[string]any); last["id"] != id {
		t.Errorf("archived entry should sort last: %s", sorted.Raw)
	}
	if res := a.Do(http.MethodPatch, "/api/medicines/"+id, cookie, map[string]any{"name": ""}); res.Status != http.StatusBadRequest {
		t.Errorf("blank rename = %d, want 400", res.Status)
	}

	// Deleting the entry leaves the dose with its name and no link.
	if res := a.Do(http.MethodDelete, "/api/medicines/"+id, cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete = %d %s", res.Status, res.Raw)
	}
	doses = a.DoArray(http.MethodGet, "/api/medicine?babyId="+babyID, cookie, nil)
	if row, _ := doses.JSON[0].(map[string]any); row["name"] != "Paracetamol" || row["medicineId"] != nil {
		t.Errorf("dose after entry delete = %v, want the name kept and medicineId null", row)
	}
	if res := a.Do(http.MethodDelete, "/api/medicines/"+id, cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", res.Status)
	}
}

func TestMedicineCatalogueIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	otherFamily, otherCookie := a.NewFamily("Berg", "other@example.com")
	otherBaby := a.NewBaby(otherFamily, "Ola")

	created := a.Do(http.MethodPost, "/api/medicines", cookie, map[string]any{"name": "Paracetamol"})
	id, _ := created.JSON["id"].(string)

	if list := a.DoArray(http.MethodGet, "/api/medicines", otherCookie, nil); len(list.JSON) != 0 {
		t.Errorf("other family's list = %s, want empty", list.Raw)
	}
	if res := a.Do(http.MethodPatch, "/api/medicines/"+id, otherCookie, map[string]any{"name": "x"}); res.Status != http.StatusNotFound {
		t.Errorf("cross-family patch = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/medicines/"+id, otherCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("cross-family delete = %d, want 404", res.Status)
	}
	// A dose may not point at another family's entry.
	res := a.Do(http.MethodPost, "/api/medicine", otherCookie, map[string]any{
		"babyId": otherBaby, "time": time.Now().UTC().Format(time.RFC3339), "name": "Paracetamol", "medicineId": id,
	})
	if res.Status != http.StatusNotFound {
		t.Errorf("cross-family dose link = %d %s, want 404", res.Status, res.Raw)
	}
	// And a dose in the right family may drop the link with null.
	own := a.Do(http.MethodPost, "/api/medicine", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "Paracetamol", "medicineId": id,
	})
	doseID, _ := own.JSON["id"].(string)
	unlinked := a.Do(http.MethodPatch, "/api/medicine/"+doseID, cookie, map[string]any{"medicineId": nil})
	if unlinked.Status != http.StatusOK || unlinked.JSON["medicineId"] != nil {
		t.Errorf("unlink = %d %v, want 200 and null", unlinked.Status, unlinked.JSON)
	}
}
