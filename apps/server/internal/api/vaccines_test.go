package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Vaccine log — ports apps/api/test/vaccines.test.ts's "vaccine log"
// describe block, minus the timeline-integration test (no /api/timeline
// route on this port yet).
// -----------------------------------------------------------------------

func TestCreateVaccineIsFreeAndDocumentsStartEmpty(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	res := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId":       babyID,
		"time":         time.Now().UTC().Format(time.RFC3339),
		"name":         "DTP-IPV-Hib-HepB",
		"doseNumber":   1,
		"scheduleSlot": "dtp-ipv-hib-hepb:1",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["name"] != "DTP-IPV-Hib-HepB" {
		t.Errorf("name = %v, want %q", res.JSON["name"], "DTP-IPV-Hib-HepB")
	}
	if res.JSON["scheduleSlot"] != "dtp-ipv-hib-hepb:1" {
		t.Errorf("scheduleSlot = %v, want %q", res.JSON["scheduleSlot"], "dtp-ipv-hib-hepb:1")
	}
	docs, ok := res.JSON["documents"].([]any)
	if !ok || len(docs) != 0 {
		t.Errorf("documents = %v, want an empty array", res.JSON["documents"])
	}
}

func TestUpdateVaccineAcceptsOffProgrammeClears(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId":       babyID,
		"time":         time.Now().UTC().Format(time.RFC3339),
		"name":         "Yellow fever",
		"doseNumber":   1,
		"scheduleSlot": "mmr:1",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	updated := a.Do(http.MethodPatch, "/api/vaccines/"+id, cookie, map[string]any{
		"scheduleSlot": nil,
		"doseNumber":   nil,
	})
	if updated.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", updated.Status, updated.Raw)
	}
	if updated.JSON["scheduleSlot"] != nil {
		t.Errorf("scheduleSlot after clear = %v, want nil", updated.JSON["scheduleSlot"])
	}
	if updated.JSON["doseNumber"] != nil {
		t.Errorf("doseNumber after clear = %v, want nil", updated.JSON["doseNumber"])
	}
	if updated.JSON["name"] != "Yellow fever" {
		t.Errorf("name after unrelated update = %v, want unchanged %q", updated.JSON["name"], "Yellow fever")
	}
}

func TestCreateVaccineUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Hansen", "parent@example.com")
	familyB, _ := a.NewFamily("Other family", "other@example.com")
	theirBaby := a.NewBaby(familyB, "Their baby")

	res := a.Do(http.MethodPost, "/api/vaccines", cookieA, map[string]any{
		"babyId": theirBaby,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"name":   "MMR",
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

// -----------------------------------------------------------------------
// Family scoping / listing / delete.
// -----------------------------------------------------------------------

func TestListVaccinesNewestFirstWithCaretakerName(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	first := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": t0.Format(time.RFC3339), "name": "MMR",
	})
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	if first.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q", first.JSON["caretakerName"], "Rig admin")
	}
	second := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": t0.Add(time.Hour).Format(time.RFC3339), "name": "HPV",
	})
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", second.Status, second.Raw)
	}

	list := a.DoArray(http.MethodGet, "/api/vaccines?babyId="+babyID, cookie, nil)
	if len(list.JSON) != 2 {
		t.Fatalf("GET /api/vaccines = %v, want 2", list.JSON)
	}
	newest := list.JSON[0].(map[string]any)
	if newest["id"] != second.JSON["id"] {
		t.Errorf("newest-first: first row id = %v, want the later entry %v", newest["id"], second.JSON["id"])
	}
}

func TestVaccinesAreFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/vaccines", cookieA, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	listA := a.DoArray(http.MethodGet, "/api/vaccines", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/vaccines", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B list = %v, want 0", listB.JSON)
	}

	patch := a.Do(http.MethodPatch, "/api/vaccines/"+id, cookieB, map[string]any{"notes": "nope"})
	if patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	del := a.Do(http.MethodDelete, "/api/vaccines/"+id, cookieB, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
}

func TestDeleteVaccineRemovesItAndUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	id, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodDelete, "/api/vaccines/"+id, cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("DELETE status = %d, body %s", del.Status, del.Raw)
	}
	if del.JSON["ok"] != true {
		t.Errorf("DELETE body = %v, want {ok:true}", del.JSON)
	}

	again := a.Do(http.MethodDelete, "/api/vaccines/"+id, cookie, nil)
	if again.Status != http.StatusNotFound {
		t.Fatalf("second DELETE status = %d, body %s, want 404", again.Status, again.Raw)
	}
}

func TestVaccinesRejectsUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/vaccines", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}

// -----------------------------------------------------------------------
// Vaccine dismissals — ports apps/api/test/vaccines.test.ts's "vaccine
// dismissals" describe block.
// -----------------------------------------------------------------------

func TestDismissRestoreVaccineSlot(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Dismissal family", "parent@example.com")
	babyID := a.NewBaby(familyID, "Dismiss baby")

	created := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookie, map[string]any{
		"babyId": babyID, "slotKey": "hpv:1",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["slotKey"] != "hpv:1" {
		t.Errorf("slotKey = %v, want %q", created.JSON["slotKey"], "hpv:1")
	}
	id, _ := created.JSON["id"].(string)

	listed := a.DoArray(http.MethodGet, "/api/vaccines/dismissals?babyId="+babyID, cookie, nil)
	if len(listed.JSON) != 1 {
		t.Fatalf("listed = %v, want 1", listed.JSON)
	}

	restored := a.Do(http.MethodDelete, "/api/vaccines/dismissals/"+id, cookie, nil)
	if restored.Status != http.StatusOK {
		t.Fatalf("DELETE status = %d, body %s", restored.Status, restored.Raw)
	}

	after := a.DoArray(http.MethodGet, "/api/vaccines/dismissals?babyId="+babyID, cookie, nil)
	if len(after.JSON) != 0 {
		t.Errorf("after restore = %v, want an empty array", after.JSON)
	}
}

func TestCreateVaccineDismissalIsIdempotent(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Dismissal family", "parent@example.com")
	babyID := a.NewBaby(familyID, "Idempotent baby")
	body := map[string]any{"babyId": babyID, "slotKey": "mmr:1"}

	first := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookie, body)
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	second := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookie, body)
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s, want 201", second.Status, second.Raw)
	}
	if second.JSON["id"] != first.JSON["id"] {
		t.Errorf("second create id = %v, want the same row %v", second.JSON["id"], first.JSON["id"])
	}

	listed := a.DoArray(http.MethodGet, "/api/vaccines/dismissals?babyId="+babyID, cookie, nil)
	if len(listed.JSON) != 1 {
		t.Errorf("listed = %v, want 1 (idempotent)", listed.JSON)
	}
}

func TestVaccineDismissalsArePerBabyNotPerFamily(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Dismissal family", "parent@example.com")
	babyID := a.NewBaby(familyID, "Has dismissal")
	sibling := a.NewBaby(familyID, "Sibling")

	if res := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookie, map[string]any{
		"babyId": babyID, "slotKey": "mmr:1",
	}); res.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", res.Status, res.Raw)
	}

	theirs := a.DoArray(http.MethodGet, "/api/vaccines/dismissals?babyId="+sibling, cookie, nil)
	if len(theirs.JSON) != 0 {
		t.Errorf("sibling's dismissals = %v, want an empty array", theirs.JSON)
	}
}

func TestVaccineDismissalDoesNotBlockLoggingTheVaccine(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Dismissal family", "parent@example.com")
	babyID := a.NewBaby(familyID, "Logs anyway")

	if res := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookie, map[string]any{
		"babyId": babyID, "slotKey": "mmr:1",
	}); res.Status != http.StatusCreated {
		t.Fatalf("dismissal POST status = %d, body %s", res.Status, res.Raw)
	}

	logged := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId":       babyID,
		"time":         time.Now().UTC().Format(time.RFC3339),
		"name":         "MMR",
		"doseNumber":   1,
		"scheduleSlot": "mmr:1",
	})
	if logged.Status != http.StatusCreated {
		t.Errorf("vaccine POST status = %d, body %s, want 201", logged.Status, logged.Raw)
	}
}

func TestCreateVaccineDismissalUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Dismissal family", "parent@example.com")
	familyB, _ := a.NewFamily("Other dismissal family", "other@example.com")
	theirBaby := a.NewBaby(familyB, "Their baby")

	res := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookieA, map[string]any{
		"babyId": theirBaby, "slotKey": "mmr:1",
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

func TestVaccineDismissalIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Dismissal family", "parent@example.com")
	babyID := a.NewBaby(familyID, "Guarded baby")
	_, otherCookie := a.NewFamily("Outsider family", "outsider@example.com")

	created := a.Do(http.MethodPost, "/api/vaccines/dismissals", cookie, map[string]any{
		"babyId": babyID, "slotKey": "mmr:1",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodDelete, "/api/vaccines/dismissals/"+id, otherCookie, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}
	// Still ours — the refusal deleted nothing.
	listed := a.DoArray(http.MethodGet, "/api/vaccines/dismissals?babyId="+babyID, cookie, nil)
	if len(listed.JSON) != 1 {
		t.Errorf("listed after refused cross-family delete = %v, want 1", listed.JSON)
	}
}

// Ordering hazard: /api/vaccines/{id} could swallow "dismissals" as an id.
// Go's net/http.ServeMux prefers the literal "/api/vaccines/dismissals"
// pattern over the "/api/vaccines/{id}" wildcard regardless of
// registration order, but this proves it end to end rather than trusting
// that guarantee blind.
func TestVaccineDismissalsPathIsNotCapturedAsAnId(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Routing family", "parent@example.com")
	babyID := a.NewBaby(familyID, "Routing baby")

	res := a.DoArray(http.MethodGet, "/api/vaccines/dismissals?babyId="+babyID, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s, want 200", res.Status, res.Raw)
	}
}
