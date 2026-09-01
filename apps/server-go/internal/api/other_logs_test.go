package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// The six Phase 3 activity types — medicine, baths, notes, milestones,
// measurements, pumps — port apps/api/test/other-logs.test.ts (medicine
// exercised deeply, the rest via a table-driven loop, per that file's own
// comment: "Medicine is exercised deeply; the rest get a create/read pass
// through the same code path") and apps/api/test/entitlement-rework.test.ts
// INVERTED: that TS file asserted 402 PLAN_REQUIRED for five of these six
// kinds on a free-plan family; Task 1's Go-side entitlement rework removed
// that gate entirely (REF §A1: "All previously-gated creates become free in
// Go"), so TestOtherKindsCreateIsFreeOnDefaultPlan asserts 201 instead,
// exactly the assertions babies_test.go already made for CreateBaby's own
// removed multipleBabies gate.
// -----------------------------------------------------------------------

// --- medicine (deep coverage) ---

func TestListMedicineEmptyFamily(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.DoArray(http.MethodGet, "/api/medicine", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if len(res.JSON) != 0 {
		t.Fatalf("JSON = %v, want an empty array", res.JSON)
	}
}

func TestCreateMedicineUnknownBabyIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/medicine", cookie, map[string]any{
		"babyId": "does-not-exist",
		"time":   time.Now().UTC().Format(time.RFC3339),
		"name":   "Paracet",
	})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Unknown baby" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Unknown baby\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

// Ports other-logs.test.ts's "medicine: full CRUD with null-to-clear
// patches, family-scoped" case end to end.
func TestMedicineFullCRUDWithNullToClearPatches(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	_, cookieB := a.NewFamily("Family B", "b@example.com")
	babyA := a.NewBaby(familyA, "Baby A")

	created := a.Do(http.MethodPost, "/api/medicine", cookieA, map[string]any{
		"babyId": babyA,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"name":   "Paracet",
		"amount": 2.5,
		"unit":   "ml",
		"notes":  "before bed",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["name"] != "Paracet" {
		t.Errorf("name = %v, want Paracet", created.JSON["name"])
	}
	if created.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q", created.JSON["caretakerName"], "Rig admin")
	}
	if created.JSON["amount"] != 2.5 {
		t.Errorf("amount = %v, want 2.5", created.JSON["amount"])
	}
	id, _ := created.JSON["id"].(string)

	// Cross-family: B sees nothing and cannot touch it.
	bList := a.DoArray(http.MethodGet, "/api/medicine", cookieB, nil)
	if len(bList.JSON) != 0 {
		t.Errorf("family B list = %v, want empty", bList.JSON)
	}
	if patch := a.Do(http.MethodPatch, "/api/medicine/"+id, cookieB, map[string]any{"name": "hijack"}); patch.Status != http.StatusNotFound {
		t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
	}
	if del := a.Do(http.MethodDelete, "/api/medicine/"+id, cookieB, nil); del.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
	}

	// Patch: change name, clear amount/unit/notes.
	patched := a.Do(http.MethodPatch, "/api/medicine/"+id, cookieA, map[string]any{
		"name": "Ibux", "amount": nil, "unit": nil, "notes": nil,
	})
	if patched.Status != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", patched.Status, patched.Raw)
	}
	if patched.JSON["name"] != "Ibux" {
		t.Errorf("name = %v, want Ibux", patched.JSON["name"])
	}
	if patched.JSON["amount"] != nil {
		t.Errorf("amount = %v, want null", patched.JSON["amount"])
	}
	if patched.JSON["unit"] != nil {
		t.Errorf("unit = %v, want null", patched.JSON["unit"])
	}
	if patched.JSON["notes"] != nil {
		t.Errorf("notes = %v, want null", patched.JSON["notes"])
	}

	// Logging against another family's baby is refused.
	crossCreate := a.Do(http.MethodPost, "/api/medicine", cookieB, map[string]any{
		"babyId": babyA,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"name":   "nope",
	})
	if crossCreate.Status != http.StatusNotFound {
		t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
	}

	// Delete.
	if del := a.Do(http.MethodDelete, "/api/medicine/"+id, cookieA, nil); del.Status != http.StatusOK || del.JSON["ok"] != true {
		t.Fatalf("DELETE status = %d body = %v, want 200 {ok:true}", del.Status, del.JSON)
	}
	list := a.DoArray(http.MethodGet, "/api/medicine", cookieA, nil)
	if len(list.JSON) != 0 {
		t.Errorf("list after delete = %v, want empty", list.JSON)
	}
}

func TestListMedicineNewestFirstWithLimitBounds(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	var last map[string]any
	for i := 0; i < 3; i++ {
		res := a.Do(http.MethodPost, "/api/medicine", cookie, map[string]any{
			"babyId": babyID,
			"time":   time.Date(2026, 1, 1, 8, i, 0, 0, time.UTC).Format(time.RFC3339),
			"name":   "Dose",
		})
		if res.Status != http.StatusCreated {
			t.Fatalf("seed POST %d status = %d, body %s", i, res.Status, res.Raw)
		}
		last = res.JSON
	}

	list := a.DoArray(http.MethodGet, "/api/medicine", cookie, nil)
	if len(list.JSON) != 3 {
		t.Fatalf("GET /api/medicine = %v, want 3", list.JSON)
	}
	newest := list.JSON[0].(map[string]any)
	if newest["id"] != last["id"] {
		t.Errorf("newest-first: first row id = %v, want the latest dose %v", newest["id"], last["id"])
	}

	limited := a.DoArray(http.MethodGet, "/api/medicine?limit=2", cookie, nil)
	if len(limited.JSON) != 2 {
		t.Fatalf("GET ?limit=2 = %v, want 2 rows", limited.JSON)
	}

	tooLow := a.Do(http.MethodGet, "/api/medicine?limit=0", cookie, nil)
	if tooLow.Status != http.StatusBadRequest || tooLow.JSON["code"] != "VALIDATION" {
		t.Errorf("GET ?limit=0 status/code = %d/%v, want 400/VALIDATION", tooLow.Status, tooLow.JSON["code"])
	}
	tooHigh := a.Do(http.MethodGet, "/api/medicine?limit=201", cookie, nil)
	if tooHigh.Status != http.StatusBadRequest {
		t.Errorf("GET ?limit=201 status = %d, want 400", tooHigh.Status)
	}
}

// Bounds parity with the zod schema (packages/shared/src/schemas.ts):
// name 1..100, amount 0..1000, unit must be one of the fixed enum.
func TestCreateMedicineBounds(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	cases := []struct {
		name string
		body map[string]any
	}{
		{"empty name", map[string]any{"name": ""}},
		{"name too long", map[string]any{"name": stringOfLen(101)}},
		{"amount below range", map[string]any{"name": "x", "amount": -1}},
		{"amount above range", map[string]any{"name": "x", "amount": 1001}},
		{"invalid unit", map[string]any{"name": "x", "unit": "tablespoon"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body := map[string]any{"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.body {
				body[k] = v
			}
			res := a.Do(http.MethodPost, "/api/medicine", cookie, body)
			if res.Status != http.StatusBadRequest {
				t.Errorf("status = %d, body %s, want 400 VALIDATION", res.Status, res.Raw)
			}
		})
	}
}

// Code-review follow-up (minor): TestCreateMedicineBounds above only covers
// medicine's own bounds; this closes the same gap for the other five kinds'
// create-time bounds — one over-the-limit case per bounded field
// (content/title/measurement.value/pump.amountMl/pump.durationMin) — cheap
// since it's the same table-driven shape TestOtherKindsCRUD already uses.
func TestOtherKindsCreateBounds(t *testing.T) {
	cases := []struct {
		name  string
		base  string
		extra map[string]any
	}{
		{"note content too long", "notes", map[string]any{"content": stringOfLen(2001)}},
		{"milestone title too long", "milestones", map[string]any{"title": stringOfLen(201)}},
		{"measurement value above range", "measurements", map[string]any{"type": "weight", "value": 201}},
		{"pump amountMl above range", "pumps", map[string]any{"amountMl": 1001}},
		{"pump durationMin above range", "pumps", map[string]any{"durationMin": 601}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := testrig.App(t)
			familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
			babyID := a.NewBaby(familyID, "Nora")

			body := map[string]any{"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.extra {
				body[k] = v
			}
			res := a.Do(http.MethodPost, "/api/"+c.base, cookie, body)
			if res.Status != http.StatusBadRequest {
				t.Errorf("POST /api/%s status = %d, body %s, want 400 VALIDATION", c.base, res.Status, res.Raw)
			}
			if res.JSON["code"] != "VALIDATION" {
				t.Errorf("code = %v, want VALIDATION", res.JSON["code"])
			}
		})
	}
}

func TestDeleteMedicineUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodDelete, "/api/medicine/does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res.JSON["error"] != "Not found" || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("body = %v, want {error:\"Not found\",code:\"NOT_FOUND\"}", res.JSON)
	}
}

func TestUpdateMedicineUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPatch, "/api/medicine/does-not-exist", cookie, map[string]any{"name": "x"})
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

// Ports defects.test.ts's "empty PATCH bodies are no-ops" for medicine.
func TestUpdateMedicineEmptyPatchIsANoOp(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/medicine", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"name":   "Paracet",
		"amount": 2.5,
	})
	id, _ := created.JSON["id"].(string)

	res := a.Do(http.MethodPatch, "/api/medicine/"+id, cookie, map[string]any{})
	if res.Status != http.StatusOK {
		t.Fatalf("empty-PATCH status = %d, body %s, want 200", res.Status, res.Raw)
	}
	if res.JSON["amount"] != 2.5 || res.JSON["name"] != "Paracet" {
		t.Errorf("after empty PATCH = %v, want unchanged", res.JSON)
	}
}

// Code-review follow-up: PATCH's tri-state pattern (patch.go) makes `null`
// mean "clear this column" for nullable fields, but `name` is REQUIRED and
// NOT nullable (UpdateMedicine's OpenAPI schema carries no `nullable: true`
// for it — see openapi/pjokk.yaml). Sending `{"name": null}` must therefore
// be rejected by spec (kin-openapi) validation before this handler ever
// runs, the same way an out-of-range or wrong-typed field is — a genuinely
// clearable field's null is a normal 200 (see
// TestMedicineFullCRUDWithNullToClearPatches), so this is the one case
// asserting the OTHER outcome for a non-clearable field, previously
// unverified anywhere in the suite.
func TestUpdateMedicineRejectsNullOnRequiredField(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/medicine", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"name":   "Paracet",
	})
	id, _ := created.JSON["id"].(string)

	res := a.Do(http.MethodPatch, "/api/medicine/"+id, cookie, map[string]any{"name": nil})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("PATCH {name:null} status = %d, body %s, want 400 VALIDATION", res.Status, res.Raw)
	}
	if res.JSON["code"] != "VALIDATION" {
		t.Errorf("code = %v, want VALIDATION", res.JSON["code"])
	}

	// Confirm the row itself was untouched by the rejected request.
	list := a.DoArray(http.MethodGet, "/api/medicine", cookie, nil)
	row := list.JSON[0].(map[string]any)
	if row["name"] != "Paracet" {
		t.Errorf("name after rejected null-PATCH = %v, want unchanged %q", row["name"], "Paracet")
	}
}

// Same check as TestUpdateMedicineRejectsNullOnRequiredField, on a different
// field TYPE shape (a required float64 rather than a required string) —
// measurement.value is required and not nullable, so `{"value": null}` must
// 400 rather than clear it (there is no "cleared" state for value to be in).
func TestUpdateMeasurementRejectsNullOnRequiredField(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/measurements", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "weight",
		"value":  5.2,
	})
	id, _ := created.JSON["id"].(string)

	res := a.Do(http.MethodPatch, "/api/measurements/"+id, cookie, map[string]any{"value": nil})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("PATCH {value:null} status = %d, body %s, want 400 VALIDATION", res.Status, res.Raw)
	}
	if res.JSON["code"] != "VALIDATION" {
		t.Errorf("code = %v, want VALIDATION", res.JSON["code"])
	}

	list := a.DoArray(http.MethodGet, "/api/measurements", cookie, nil)
	row := list.JSON[0].(map[string]any)
	if row["value"] != 5.2 {
		t.Errorf("value after rejected null-PATCH = %v, want unchanged 5.2", row["value"])
	}
}

func TestMedicineRejectUnauthenticated(t *testing.T) {
	a := testrig.App(t)
	res := a.Do(http.MethodGet, "/api/medicine", "", nil)
	if res.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Status)
	}
}

// Self-review item: measurement `value` must stay double precision
// end-to-end. A bare `type: number` in the OpenAPI schema defaults to Go
// float32 in oapi-codegen, which would round-trip a value like
// 123.456789 (9 significant digits, more than float32's ~7) lossily —
// Task 12 added `format: double` to fix this (see openapi/pjokk.yaml's
// MeasurementLog/CreateMeasurement/UpdateMeasurement schemas). Exercised on
// create, list and PATCH so a regression on any one of the three paths
// fails this test.
func TestMeasurementValuePreservesDoublePrecision(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	const precise = 123.456789

	created := a.Do(http.MethodPost, "/api/measurements", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "weight",
		"value":  precise,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	if created.JSON["value"] != precise {
		t.Errorf("created value = %v, want exactly %v (float32 would round this)", created.JSON["value"], precise)
	}
	id, _ := created.JSON["id"].(string)

	list := a.DoArray(http.MethodGet, "/api/measurements", cookie, nil)
	row := list.JSON[0].(map[string]any)
	if row["value"] != precise {
		t.Errorf("listed value = %v, want exactly %v", row["value"], precise)
	}

	patched := a.Do(http.MethodPatch, "/api/measurements/"+id, cookie, map[string]any{"value": precise})
	if patched.JSON["value"] != precise {
		t.Errorf("patched value = %v, want exactly %v", patched.JSON["value"], precise)
	}
}

// --- baths, notes, milestones, measurements, pumps (table-driven) ---

// otherKindCase describes one non-medicine kind's create/patch shape.
type otherKindCase struct {
	base       string
	extra      map[string]any // extra fields (besides babyId/time) for create
	patch      map[string]any // a PATCH body exercising set/clear on the extra fields
	patchCheck map[string]any // expected values after the patch (nil means "expect JSON null")
}

func otherKindCases() []otherKindCase {
	return []otherKindCase{
		{
			base:       "baths",
			extra:      map[string]any{},
			patch:      map[string]any{"notes": "washed hair"},
			patchCheck: map[string]any{"notes": "washed hair"},
		},
		{
			base:       "notes",
			extra:      map[string]any{"content": "First taste of banana."},
			patch:      map[string]any{"content": "Big fan of banana."},
			patchCheck: map[string]any{"content": "Big fan of banana."},
		},
		{
			base:       "milestones",
			extra:      map[string]any{"title": "Stood unsupported"},
			patch:      map[string]any{"title": "Took first steps"},
			patchCheck: map[string]any{"title": "Took first steps"},
		},
		{
			base:       "measurements",
			extra:      map[string]any{"type": "weight", "value": 8.4},
			patch:      map[string]any{"value": 9.1},
			patchCheck: map[string]any{"value": 9.1},
		},
		{
			base:       "pumps",
			extra:      map[string]any{"side": "left", "amountMl": float64(90), "durationMin": float64(15)},
			patch:      map[string]any{"side": nil, "amountMl": nil, "durationMin": nil},
			patchCheck: map[string]any{"side": nil, "amountMl": nil, "durationMin": nil},
		},
	}
}

// TestOtherKindsCRUD ports other-logs.test.ts's "all six types create" case
// for the five non-medicine kinds (medicine has its own deep test above):
// create/list/patch/delete each, through the exact same shared engine
// (other_logs.go) medicine uses.
func TestOtherKindsCRUD(t *testing.T) {
	for _, c := range otherKindCases() {
		t.Run(c.base, func(t *testing.T) {
			a := testrig.App(t)
			familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
			babyID := a.NewBaby(familyID, "Nora")

			body := map[string]any{"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.extra {
				body[k] = v
			}
			created := a.Do(http.MethodPost, "/api/"+c.base, cookie, body)
			if created.Status != http.StatusCreated {
				t.Fatalf("POST /api/%s status = %d, body %s", c.base, created.Status, created.Raw)
			}
			if created.JSON["caretakerName"] != "Rig admin" {
				t.Errorf("caretakerName = %v, want %q", created.JSON["caretakerName"], "Rig admin")
			}
			id, _ := created.JSON["id"].(string)

			list := a.DoArray(http.MethodGet, "/api/"+c.base, cookie, nil)
			if len(list.JSON) != 1 {
				t.Fatalf("GET /api/%s = %v, want 1 row", c.base, list.JSON)
			}

			patched := a.Do(http.MethodPatch, "/api/"+c.base+"/"+id, cookie, c.patch)
			if patched.Status != http.StatusOK {
				t.Fatalf("PATCH /api/%s status = %d, body %s", c.base, patched.Status, patched.Raw)
			}
			for k, want := range c.patchCheck {
				if got := patched.JSON[k]; got != want {
					t.Errorf("after PATCH, %s = %v, want %v", k, got, want)
				}
			}

			del := a.Do(http.MethodDelete, "/api/"+c.base+"/"+id, cookie, nil)
			if del.Status != http.StatusOK || del.JSON["ok"] != true {
				t.Fatalf("DELETE /api/%s status = %d body = %v, want 200 {ok:true}", c.base, del.Status, del.JSON)
			}
			listAfter := a.DoArray(http.MethodGet, "/api/"+c.base, cookie, nil)
			if len(listAfter.JSON) != 0 {
				t.Errorf("GET /api/%s after delete = %v, want empty", c.base, listAfter.JSON)
			}

			// Unknown baby / unknown id, same convention as medicine.
			mergedBadBaby := map[string]any{"babyId": "does-not-exist", "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.extra {
				mergedBadBaby[k] = v
			}
			badBaby := a.Do(http.MethodPost, "/api/"+c.base, cookie, mergedBadBaby)
			if badBaby.Status != http.StatusNotFound {
				t.Errorf("POST /api/%s with unknown baby status = %d, want 404", c.base, badBaby.Status)
			}

			badPatch := a.Do(http.MethodPatch, "/api/"+c.base+"/does-not-exist", cookie, map[string]any{})
			if badPatch.Status != http.StatusNotFound {
				t.Errorf("PATCH /api/%s/does-not-exist status = %d, want 404", c.base, badPatch.Status)
			}
			badDelete := a.Do(http.MethodDelete, "/api/"+c.base+"/does-not-exist", cookie, nil)
			if badDelete.Status != http.StatusNotFound {
				t.Errorf("DELETE /api/%s/does-not-exist status = %d, want 404", c.base, badDelete.Status)
			}
		})
	}
}

// allSixKinds is otherKindCases() plus medicine, for the two loops (family
// scoping, entitlement) that genuinely need all six rather than five.
func allSixKinds() []otherKindCase {
	return append([]otherKindCase{
		{base: "medicine", extra: map[string]any{"name": "Paracet"}},
	}, otherKindCases()...)
}

// TestOtherKindsAreFamilyScoped ports tenancy.test.ts's shape across all six
// kinds: list scoping, cross-family 404 by id (PATCH and DELETE), and
// logging against another family's baby.
func TestOtherKindsAreFamilyScoped(t *testing.T) {
	for _, c := range allSixKinds() {
		t.Run(c.base, func(t *testing.T) {
			a := testrig.App(t)
			familyA, cookieA := a.NewFamily("Family A", "a@example.com")
			_, cookieB := a.NewFamily("Family B", "b@example.com")
			babyA := a.NewBaby(familyA, "Baby A")

			body := map[string]any{"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.extra {
				body[k] = v
			}
			created := a.Do(http.MethodPost, "/api/"+c.base, cookieA, body)
			if created.Status != http.StatusCreated {
				t.Fatalf("POST /api/%s status = %d, body %s", c.base, created.Status, created.Raw)
			}
			id, _ := created.JSON["id"].(string)

			listA := a.DoArray(http.MethodGet, "/api/"+c.base, cookieA, nil)
			listB := a.DoArray(http.MethodGet, "/api/"+c.base, cookieB, nil)
			if len(listA.JSON) != 1 {
				t.Errorf("family A list = %v, want 1", listA.JSON)
			}
			if len(listB.JSON) != 0 {
				t.Errorf("family B list = %v, want 0", listB.JSON)
			}

			if patch := a.Do(http.MethodPatch, "/api/"+c.base+"/"+id, cookieB, map[string]any{}); patch.Status != http.StatusNotFound {
				t.Errorf("cross-family PATCH status = %d, want 404", patch.Status)
			}
			if del := a.Do(http.MethodDelete, "/api/"+c.base+"/"+id, cookieB, nil); del.Status != http.StatusNotFound {
				t.Errorf("cross-family DELETE status = %d, want 404", del.Status)
			}

			crossCreateBody := map[string]any{"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.extra {
				crossCreateBody[k] = v
			}
			crossCreate := a.Do(http.MethodPost, "/api/"+c.base, cookieB, crossCreateBody)
			if crossCreate.Status != http.StatusNotFound {
				t.Errorf("logging against another family's baby status = %d, want 404", crossCreate.Status)
			}
		})
	}
}

// TestOtherKindsCreateIsFreeOnDefaultPlan is entitlement-rework.test.ts
// INVERTED (see this file's package doc comment): every kind creates 201 on
// a fresh, untouched (therefore `free`) family — no setPlan, no
// PLAN_REQUIRED anywhere in this route surface.
func TestOtherKindsCreateIsFreeOnDefaultPlan(t *testing.T) {
	for _, c := range allSixKinds() {
		t.Run(c.base, func(t *testing.T) {
			a := testrig.App(t)
			familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
			babyID := a.NewBaby(familyID, "Nora")

			body := map[string]any{"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339)}
			for k, v := range c.extra {
				body[k] = v
			}
			res := a.Do(http.MethodPost, "/api/"+c.base, cookie, body)
			if res.Status != http.StatusCreated {
				t.Fatalf("POST /api/%s on a fresh free-plan family: status = %d, body %s, want 201 (no PLAN_REQUIRED gate in Go)", c.base, res.Status, res.Raw)
			}
		})
	}
}

func stringOfLen(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'x'
	}
	return string(b)
}
