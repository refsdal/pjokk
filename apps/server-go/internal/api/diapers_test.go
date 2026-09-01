package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Diapers — the same skeleton as feeds_test.go, minus the feed-only fields.
// -----------------------------------------------------------------------

func TestListDiapersEmptyFamily(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.DoArray(http.MethodGet, "/api/diapers", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if len(res.JSON) != 0 {
		t.Fatalf("JSON = %v, want an empty array", res.JSON)
	}
}

func TestCreateDiaperUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": "does-not-exist",
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestCreateDiaperAndListNewestFirstWithCaretakerName(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)
	first := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   t0.Format(time.RFC3339),
		"type":   "wet",
	})
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	if first.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q", first.JSON["caretakerName"], "Rig admin")
	}

	second := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   t0.Add(time.Hour).Format(time.RFC3339),
		"type":   "both",
		"notes":  "explosive",
	})
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", second.Status, second.Raw)
	}

	list := a.DoArray(http.MethodGet, "/api/diapers", cookie, nil)
	if len(list.JSON) != 2 {
		t.Fatalf("GET /api/diapers = %v, want 2", list.JSON)
	}
	newest := list.JSON[0].(map[string]any)
	if newest["id"] != second.JSON["id"] {
		t.Errorf("newest-first: first row id = %v, want the later diaper %v", newest["id"], second.JSON["id"])
	}
	if newest["notes"] != "explosive" {
		t.Errorf("notes = %v, want %q", newest["notes"], "explosive")
	}
}

func TestDeleteDiaperUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodDelete, "/api/diapers/does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

func TestDeleteDiaperRemovesIt(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "dirty",
	})
	id, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodDelete, "/api/diapers/"+id, cookie, nil)
	if del.Status != http.StatusOK || del.JSON["ok"] != true {
		t.Fatalf("DELETE status = %d body = %v, want 200 {ok:true}", del.Status, del.JSON)
	}

	list := a.DoArray(http.MethodGet, "/api/diapers", cookie, nil)
	if len(list.JSON) != 0 {
		t.Fatalf("GET after delete = %v, want empty", list.JSON)
	}
}

func TestUpdateDiaperUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPatch, "/api/diapers/does-not-exist", cookie, map[string]any{"type": "wet"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

// Ports defects.test.ts's "empty PATCH bodies are no-ops, not 500s" for
// diapers (the TS test itself only covered feeds/baths/babies; diapers.ts
// shares the exact same update() implementation via scoped.ts's logCrud, so
// this closes that gap in the Go port).
func TestUpdateDiaperEmptyPatchIsANoOp(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
		"notes":  "hello",
	})
	id, _ := created.JSON["id"].(string)

	res := a.Do(http.MethodPatch, "/api/diapers/"+id, cookie, map[string]any{})
	if res.Status != http.StatusOK {
		t.Fatalf("empty-PATCH status = %d, body %s, want 200", res.Status, res.Raw)
	}
	if res.JSON["notes"] != "hello" {
		t.Errorf("notes after empty PATCH = %v, want unchanged %q", res.JSON["notes"], "hello")
	}
	if res.JSON["type"] != "wet" {
		t.Errorf("type after empty PATCH = %v, want unchanged wet", res.JSON["type"])
	}
}

// The nullable-clear half of the PATCH tri-state pattern for diapers' one
// clearable field.
func TestUpdateDiaperPatchClearsNotes(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/diapers", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
		"notes":  "hello",
	})
	id, _ := created.JSON["id"].(string)

	cleared := a.Do(http.MethodPatch, "/api/diapers/"+id, cookie, map[string]any{"notes": nil})
	if cleared.Status != http.StatusOK {
		t.Fatalf("clearing PATCH status = %d, body %s", cleared.Status, cleared.Raw)
	}
	if cleared.JSON["notes"] != nil {
		t.Errorf("notes after explicit-null PATCH = %v, want null", cleared.JSON["notes"])
	}

	// type, omitted on the clearing PATCH, must be untouched.
	if cleared.JSON["type"] != "wet" {
		t.Errorf("type after clearing PATCH = %v, want unchanged wet", cleared.JSON["type"])
	}

	untouched := a.Do(http.MethodPatch, "/api/diapers/"+id, cookie, map[string]any{"type": "dirty"})
	if untouched.Status != http.StatusOK {
		t.Fatalf("second PATCH status = %d, body %s", untouched.Status, untouched.Raw)
	}
	if untouched.JSON["notes"] != nil {
		t.Errorf("notes after an unrelated PATCH = %v, want still null", untouched.JSON["notes"])
	}
	if untouched.JSON["type"] != "dirty" {
		t.Errorf("type = %v, want dirty", untouched.JSON["type"])
	}
}

// Ports tenancy.test.ts's cross-family-by-id shape for diapers.
func TestDiapersAreFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/diapers", cookieA, map[string]any{
		"babyId": babyA,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
	})
	diaperID, _ := created.JSON["id"].(string)

	listA := a.DoArray(http.MethodGet, "/api/diapers", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/diapers", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B list = %v, want 0", listB.JSON)
	}

	patch := a.Do(http.MethodPatch, "/api/diapers/"+diaperID, cookieB, map[string]any{"type": "dirty"})
	if patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	del := a.Do(http.MethodDelete, "/api/diapers/"+diaperID, cookieB, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	crossCreate := a.Do(http.MethodPost, "/api/diapers", cookieB, map[string]any{
		"babyId": babyA,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
	})
	if crossCreate.Status != http.StatusNotFound {
		t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
	}
}
