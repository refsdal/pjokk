package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// What a kiosk device may call (docs/superpowers/specs/
// 2026-09-10-kiosk-devices-design.md §4): an allowlist of the kiosk's own
// operations, attribution through X-Pjokk-Caretaker, and the family fence.
// -----------------------------------------------------------------------

type deviceWorld struct {
	t        *testing.T
	a        *testrig.AppRig
	familyID string
	babyID   string
	memberID string
	device   string // Cookie header value
}

func newDeviceWorld(t *testing.T) deviceWorld {
	t.Helper()
	a := testrig.App(t)
	familyID, _ := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	memberID := a.SignUp("Bo Hansen", "bo@example.com")
	a.AddMember(familyID, memberID, auth.RoleMember, "bo@example.com")
	return deviceWorld{
		t:        t,
		a:        a,
		familyID: familyID,
		babyID:   babyID,
		memberID: memberID,
		device:   a.CreateDevice(familyID, memberID),
	}
}

// do sends one request as the device, naming caretaker when non-empty.
func (w deviceWorld) do(method, path, caretaker string, body any) *testrig.Result {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			w.t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Cookie", w.device)
	if caretaker != "" {
		req.Header.Set("X-Pjokk-Caretaker", caretaker)
	}
	return w.a.DoRequest(req)
}

func TestDeviceReadsAnAllowlistedOperation(t *testing.T) {
	w := newDeviceWorld(t)
	res := w.do(http.MethodGet, "/api/summary?babyId="+w.babyID, "", nil)
	if res.Status != http.StatusOK {
		t.Fatalf("GET /api/summary as a device = %d, want 200 (body %s)", res.Status, res.Raw)
	}
}

func TestDeviceIsRefusedOutsideTheAllowlist(t *testing.T) {
	w := newDeviceWorld(t)
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/me", nil},
		{http.MethodGet, "/api/family", nil},
		{http.MethodGet, "/api/reminders", nil},
		{http.MethodGet, "/api/keys", nil},
		{http.MethodPost, "/api/invites", map[string]any{}},
	} {
		res := w.do(c.method, c.path, w.memberID, c.body)
		if res.Status != http.StatusForbidden || res.JSON["code"] != "NOT_FOR_DEVICES" {
			t.Errorf("%s %s as a device = %d %v, want 403 NOT_FOR_DEVICES", c.method, c.path, res.Status, res.JSON)
		}
	}
}

func TestDeviceLogIsAttributedToTheCaretaker(t *testing.T) {
	w := newDeviceWorld(t)
	res := w.do(http.MethodPost, "/api/diapers", w.memberID, map[string]any{
		"babyId": w.babyID,
		"time":   time.Now().Format(time.RFC3339),
		"type":   "wet",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("POST /api/diapers as a device = %d, want 201 (body %s)", res.Status, res.Raw)
	}
	if res.JSON["caretakerId"] != w.memberID || res.JSON["caretakerName"] != "Bo Hansen" {
		t.Errorf("caretaker = %v / %v, want %q / %q", res.JSON["caretakerId"], res.JSON["caretakerName"], w.memberID, "Bo Hansen")
	}
}

func TestDeviceWriteWithoutACaretakerIsRefused(t *testing.T) {
	w := newDeviceWorld(t)
	res := w.do(http.MethodPost, "/api/diapers", "", map[string]any{
		"babyId": w.babyID,
		"time":   time.Now().Format(time.RFC3339),
		"type":   "wet",
	})
	if res.Status != http.StatusBadRequest || res.JSON["code"] != "CARETAKER_REQUIRED" {
		t.Errorf("POST /api/diapers without a caretaker = %d %v, want 400 CARETAKER_REQUIRED", res.Status, res.JSON)
	}
}

func TestDeviceCannotReachAnotherFamily(t *testing.T) {
	w := newDeviceWorld(t)
	otherFamily, _ := w.a.NewFamily("Nordmann", "ola@example.com")
	otherBaby := w.a.NewBaby(otherFamily, "Kari")

	res := w.do(http.MethodGet, "/api/summary?babyId="+otherBaby, "", nil)
	if res.Status != http.StatusNotFound {
		t.Errorf("GET another family's summary as a device = %d, want 404 (body %s)", res.Status, res.Raw)
	}
	res = w.do(http.MethodPost, "/api/diapers", w.memberID, map[string]any{
		"babyId": otherBaby,
		"time":   time.Now().Format(time.RFC3339),
		"type":   "wet",
	})
	if res.Status == http.StatusCreated {
		t.Errorf("POST a diaper for another family's baby as a device = 201, want a refusal")
	}
}

func TestDeviceHandRoutedRoutes(t *testing.T) {
	w := newDeviceWorld(t)

	// The avatar READ is the kiosk's caretaker row: it must get past the
	// chain (no photo uploaded, so 404 — not 401).
	if res := w.do(http.MethodGet, "/api/users/"+w.memberID+"/avatar", "", nil); res.Status != http.StatusNotFound {
		t.Errorf("GET a member's avatar as a device = %d, want 404 (past the auth chain, no photo)", res.Status)
	}
	// Everything else hand-routed is a person's, not the family's.
	if res := w.do(http.MethodDelete, "/api/me/avatar", w.memberID, nil); res.Status != http.StatusUnauthorized {
		t.Errorf("DELETE /api/me/avatar as a device = %d, want 401", res.Status)
	}
	if res := w.do(http.MethodGet, "/api/export.csv", "", nil); res.Status == http.StatusOK {
		t.Errorf("GET /api/export.csv as a device = 200, want a refusal")
	}
}
