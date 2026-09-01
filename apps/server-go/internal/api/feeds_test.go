package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Feeds — ports apps/api/test/feedback-batch.test.ts's "per-side nursing
// minutes" describe block, apps/api/test/defects.test.ts's "empty PATCH
// bodies are no-ops" case, and apps/api/test/tenancy.test.ts's feed-scoped
// assertions (list scoping, cross-family 404 by id, logging against another
// family's baby), plus CRUD/ordering/limit coverage feeds.go's own doc
// comment promises. diapers_test.go is the shorter analogue.
// -----------------------------------------------------------------------

func TestListFeedsEmptyFamily(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.DoArray(http.MethodGet, "/api/feeds", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if len(res.JSON) != 0 {
		t.Fatalf("JSON = %v, want an empty array", res.JSON)
	}
}

func TestCreateFeedUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": "does-not-exist",
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestCreateFeedAndListNewestFirstWithCaretakerName(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	t0 := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)
	first := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     t0.Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 90,
	})
	if first.Status != http.StatusCreated {
		t.Fatalf("first POST status = %d, body %s", first.Status, first.Raw)
	}
	if first.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q (see AppRig.SignUp)", first.JSON["caretakerName"], "Rig admin")
	}

	second := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":  babyID,
		"time":    t0.Add(time.Hour).Format(time.RFC3339),
		"type":    "breast",
		"side":    "left",
		"leftMin": 12,
	})
	if second.Status != http.StatusCreated {
		t.Fatalf("second POST status = %d, body %s", second.Status, second.Raw)
	}

	list := a.DoArray(http.MethodGet, "/api/feeds", cookie, nil)
	if list.Status != http.StatusOK {
		t.Fatalf("GET status = %d, body %s", list.Status, list.Raw)
	}
	if len(list.JSON) != 2 {
		t.Fatalf("GET /api/feeds = %v, want 2", list.JSON)
	}
	newest := list.JSON[0].(map[string]any)
	oldest := list.JSON[1].(map[string]any)
	if newest["id"] != second.JSON["id"] {
		t.Errorf("newest-first: first row id = %v, want the later feed %v", newest["id"], second.JSON["id"])
	}
	if oldest["id"] != first.JSON["id"] {
		t.Errorf("newest-first: second row id = %v, want the earlier feed %v", oldest["id"], first.JSON["id"])
	}
}

func TestListFeedsLimitBounds(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	for i := 0; i < 3; i++ {
		res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
			"babyId": babyID,
			"time":   time.Date(2026, 1, 1, 8, i, 0, 0, time.UTC).Format(time.RFC3339),
			"type":   "bottle",
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("seed POST %d status = %d, body %s", i, res.Status, res.Raw)
		}
	}

	limited := a.DoArray(http.MethodGet, "/api/feeds?limit=2", cookie, nil)
	if limited.Status != http.StatusOK {
		t.Fatalf("GET ?limit=2 status = %d, body %s", limited.Status, limited.Raw)
	}
	if len(limited.JSON) != 2 {
		t.Fatalf("GET ?limit=2 = %v, want 2 rows", limited.JSON)
	}

	tooLow := a.Do(http.MethodGet, "/api/feeds?limit=0", cookie, nil)
	if tooLow.Status != http.StatusBadRequest {
		t.Errorf("GET ?limit=0 status = %d, want 400 VALIDATION", tooLow.Status)
	}
	if tooLow.JSON["code"] != "VALIDATION" {
		t.Errorf("GET ?limit=0 code = %v, want VALIDATION", tooLow.JSON["code"])
	}

	tooHigh := a.Do(http.MethodGet, "/api/feeds?limit=201", cookie, nil)
	if tooHigh.Status != http.StatusBadRequest {
		t.Errorf("GET ?limit=201 status = %d, want 400 VALIDATION", tooHigh.Status)
	}
}

func TestDeleteFeedUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodDelete, "/api/feeds/does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestDeleteFeedRemovesIt(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	id, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodDelete, "/api/feeds/"+id, cookie, nil)
	if del.Status != http.StatusOK || del.JSON["ok"] != true {
		t.Fatalf("DELETE status = %d body = %v, want 200 {ok:true}", del.Status, del.JSON)
	}

	list := a.DoArray(http.MethodGet, "/api/feeds", cookie, nil)
	if len(list.JSON) != 0 {
		t.Fatalf("GET after delete = %v, want empty", list.JSON)
	}
}

func TestUpdateFeedUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPatch, "/api/feeds/does-not-exist", cookie, map[string]any{"amountMl": 10})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

// Ports defects.test.ts's "empty PATCH bodies are no-ops, not 500s" for feeds.
func TestUpdateFeedEmptyPatchIsANoOp(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 120,
	})
	id, _ := created.JSON["id"].(string)

	res := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{})
	if res.Status != http.StatusOK {
		t.Fatalf("empty-PATCH status = %d, body %s, want 200", res.Status, res.Raw)
	}
	if res.JSON["amountMl"] != float64(120) {
		t.Errorf("amountMl after empty PATCH = %v, want unchanged 120", res.JSON["amountMl"])
	}
}

// The nullable-clear half of the PATCH tri-state pattern: set amountMl, then
// clear it with an explicit `null` — the response must come back with
// amountMl == null, distinguishing "clear" from "leave unchanged" (a
// following PATCH with amountMl simply omitted, tested alongside).
func TestUpdateFeedPatchClearsAmountMl(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 100,
	})
	id, _ := created.JSON["id"].(string)
	if created.JSON["amountMl"] != float64(100) {
		t.Fatalf("created amountMl = %v, want 100", created.JSON["amountMl"])
	}

	cleared := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"amountMl": nil})
	if cleared.Status != http.StatusOK {
		t.Fatalf("clearing PATCH status = %d, body %s", cleared.Status, cleared.Raw)
	}
	if cleared.JSON["amountMl"] != nil {
		t.Errorf("amountMl after explicit-null PATCH = %v, want null", cleared.JSON["amountMl"])
	}

	// An omitted amountMl on a later PATCH leaves the (now-null) column
	// alone rather than reintroducing a value.
	untouched := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"notes": "still bottle"})
	if untouched.Status != http.StatusOK {
		t.Fatalf("second PATCH status = %d, body %s", untouched.Status, untouched.Raw)
	}
	if untouched.JSON["amountMl"] != nil {
		t.Errorf("amountMl after an unrelated PATCH = %v, want still null (omitted fields are left alone)", untouched.JSON["amountMl"])
	}
	if untouched.JSON["notes"] != "still bottle" {
		t.Errorf("notes = %v, want %q", untouched.JSON["notes"], "still bottle")
	}
}

func TestUpdateFeedPatchSetsFieldsAndTime(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC).Format(time.RFC3339),
		"type":   "bottle",
	})
	id, _ := created.JSON["id"].(string)

	newTime := time.Date(2026, 1, 1, 9, 30, 0, 0, time.UTC)
	patch := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{
		"time":     newTime.Format(time.RFC3339),
		"type":     "breast",
		"side":     "both",
		"leftMin":  5,
		"rightMin": 7,
	})
	if patch.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", patch.Status, patch.Raw)
	}
	if patch.JSON["type"] != "breast" {
		t.Errorf("type = %v, want breast", patch.JSON["type"])
	}
	if patch.JSON["side"] != "both" {
		t.Errorf("side = %v, want both", patch.JSON["side"])
	}
	if patch.JSON["leftMin"] != float64(5) || patch.JSON["rightMin"] != float64(7) {
		t.Errorf("leftMin/rightMin = %v/%v, want 5/7", patch.JSON["leftMin"], patch.JSON["rightMin"])
	}
	gotTime, err := time.Parse(time.RFC3339, patch.JSON["time"].(string))
	if err != nil {
		t.Fatalf("parse response time %v: %v", patch.JSON["time"], err)
	}
	if !gotTime.Equal(newTime) {
		t.Errorf("time = %v, want %v", gotTime, newTime)
	}
}

// Ports feedback-batch.test.ts's "per-side nursing minutes" case, plus the
// PATCH-clearing half the TS test didn't cover.
func TestFeedLeftRightMinRoundTripAndClear(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":      babyID,
		"time":        time.Now().UTC().Format(time.RFC3339),
		"type":        "breast",
		"side":        "both",
		"durationMin": 25,
		"leftMin":     10,
		"rightMin":    15,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["leftMin"] != float64(10) || created.JSON["rightMin"] != float64(15) {
		t.Fatalf("leftMin/rightMin = %v/%v, want 10/15", created.JSON["leftMin"], created.JSON["rightMin"])
	}
	id, _ := created.JSON["id"].(string)

	cleared := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{
		"leftMin":  nil,
		"rightMin": nil,
	})
	if cleared.Status != http.StatusOK {
		t.Fatalf("clearing PATCH status = %d, body %s", cleared.Status, cleared.Raw)
	}
	if cleared.JSON["leftMin"] != nil || cleared.JSON["rightMin"] != nil {
		t.Errorf("leftMin/rightMin after clear = %v/%v, want null/null", cleared.JSON["leftMin"], cleared.JSON["rightMin"])
	}
	// durationMin was never touched by the clearing PATCH.
	if cleared.JSON["durationMin"] != float64(25) {
		t.Errorf("durationMin after unrelated clear = %v, want unchanged 25", cleared.JSON["durationMin"])
	}
}

// Ports tenancy.test.ts's feed-scoped cases: list scoping, cross-family 404
// by id (both PATCH and DELETE), and logging against another family's baby.
func TestFeedsAreFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/feeds", cookieA, map[string]any{
		"babyId":   babyA,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 100,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	feedID, _ := created.JSON["id"].(string)

	listA := a.DoArray(http.MethodGet, "/api/feeds", cookieA, nil)
	listB := a.DoArray(http.MethodGet, "/api/feeds", cookieB, nil)
	if len(listA.JSON) != 1 {
		t.Errorf("family A list = %v, want 1", listA.JSON)
	}
	if len(listB.JSON) != 0 {
		t.Errorf("family B list = %v, want 0", listB.JSON)
	}

	patch := a.Do(http.MethodPatch, "/api/feeds/"+feedID, cookieB, map[string]any{"amountMl": 999})
	if patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	del := a.Do(http.MethodDelete, "/api/feeds/"+feedID, cookieB, nil)
	if del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	stillA := a.DoArray(http.MethodGet, "/api/feeds", cookieA, nil)
	row := stillA.JSON[0].(map[string]any)
	if row["amountMl"] != float64(100) {
		t.Errorf("family A's feed amountMl after B's rejected writes = %v, want unchanged 100", row["amountMl"])
	}

	// B tries to log against A's baby.
	crossCreate := a.Do(http.MethodPost, "/api/feeds", cookieB, map[string]any{
		"babyId": babyA,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if crossCreate.Status != http.StatusNotFound {
		t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
	}
}

func TestFeedsRejectUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/feeds", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}

// withRawBody's structural size cap (internal/api/patch.go's
// maxJSONBodyBytes): an oversized JSON PATCH body is rejected with 413
// TOO_LARGE rather than being buffered to completion — and, just as
// importantly, the rig's handler survives it and keeps serving normal
// requests afterward (proving withRawBody's io.ReadAll-over-MaxBytesReader
// doesn't crash or wedge anything on overflow).
func TestUpdateFeedOversizedBodyIsRejected(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	id, _ := created.JSON["id"].(string)

	// Comfortably over maxJSONBodyBytes (1 MiB) once JSON-encoded.
	huge := strings.Repeat("x", 2<<20)
	res := a.Do(http.MethodPatch, "/api/feeds/"+id, cookie, map[string]any{"notes": huge})
	if res.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized PATCH status = %d, body %s, want 413", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Request body too large" || res.JSON["code"] != "TOO_LARGE" {
		t.Errorf("body = %v, want {error:\"Request body too large\",code:\"TOO_LARGE\"}", res.JSON)
	}

	// The rig's handler is still healthy for a normal-sized request.
	list := a.DoArray(http.MethodGet, "/api/feeds", cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("GET /api/feeds after the oversized PATCH: status = %d, JSON = %v, want 200 with 1 row", list.Status, list.JSON)
	}
}
