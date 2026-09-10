package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Settings → Family → Devices: the family-admin management surface for
// kiosk devices (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md
// §5). Enrolment itself is in device_self_test.go.
// -----------------------------------------------------------------------

// enrolCodePattern is the invite-code alphabet: no 0/O/1/I/L.
var enrolCodePattern = regexp.MustCompile(`^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$`)

func deviceUserID(t *testing.T, a *testrig.AppRig, email string) string {
	t.Helper()
	var id string
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT "id" FROM "users" WHERE "email" = $1`, email).Scan(&id); err != nil {
		t.Fatalf("user %q: %v", email, err)
	}
	return id
}

func storedCodeHash(t *testing.T, a *testrig.AppRig, deviceID string) *string {
	t.Helper()
	var h *string
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT "enrol_code_hash" FROM "device" WHERE "id" = $1`, deviceID).Scan(&h); err != nil {
		t.Fatalf("device %q: %v", deviceID, err)
	}
	return h
}

func sha256Of(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestDeviceAdminCreateListRenewRevoke(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "anne@example.com")

	created := a.Do(http.MethodPost, "/api/devices", cookie, map[string]any{"name": "  Kitchen tablet  "})
	if created.Status != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (body %s)", created.Status, created.Raw)
	}
	code, _ := created.JSON["code"].(string)
	if !enrolCodePattern.MatchString(code) {
		t.Errorf("code = %q, want 8 characters from the invite alphabet", code)
	}
	if url, _ := created.JSON["setupUrl"].(string); !strings.HasSuffix(url, "/kiosk/setup?code="+code) {
		t.Errorf("setupUrl = %q, want it to end in /kiosk/setup?code=%s", url, code)
	}
	dev, _ := created.JSON["device"].(map[string]any)
	id, _ := dev["id"].(string)
	if dev["status"] != "pending" || dev["name"] != "Kitchen tablet" || dev["createdByName"] != "Rig admin" {
		t.Errorf("device = %v, want a pending \"Kitchen tablet\" created by Rig admin", dev)
	}
	expires, err := time.Parse(time.RFC3339, fmt.Sprint(created.JSON["expiresAt"]))
	if d := time.Until(expires); err != nil || d < 14*time.Minute || d > 16*time.Minute {
		t.Errorf("expiresAt = %v, want about 15 minutes from now", created.JSON["expiresAt"])
	}
	if h := storedCodeHash(t, a, id); h == nil || *h != sha256Of(code) {
		t.Errorf("stored code hash = %v, want sha256(code) — never the code itself", h)
	}

	list := a.DoArray(http.MethodGet, "/api/devices", cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("list = %d %v, want one device", list.Status, list.JSON)
	}

	renewed := a.Do(http.MethodPost, "/api/devices/"+id+"/code", cookie, nil)
	if renewed.Status != http.StatusOK {
		t.Fatalf("renew = %d, want 200 (body %s)", renewed.Status, renewed.Raw)
	}
	newCode, _ := renewed.JSON["code"].(string)
	if newCode == code || !enrolCodePattern.MatchString(newCode) {
		t.Errorf("renewed code = %q, want a fresh code (old %q)", newCode, code)
	}
	if h := storedCodeHash(t, a, id); h == nil || *h != sha256Of(newCode) {
		t.Errorf("stored code hash after renew = %v, want sha256(new code)", h)
	}

	if res := a.Do(http.MethodDelete, "/api/devices/"+id, cookie, nil); res.Status != http.StatusNoContent {
		t.Fatalf("revoke = %d, want 204 (body %s)", res.Status, res.Raw)
	}
	if list := a.DoArray(http.MethodGet, "/api/devices", cookie, nil); len(list.JSON) != 0 {
		t.Errorf("list after revoke = %v, want empty", list.JSON)
	}
	if res := a.Do(http.MethodDelete, "/api/devices/"+id, cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("revoke twice = %d, want 404", res.Status)
	}
}

func TestDeviceAdminRenewRefusesAnEnrolledDevice(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "anne@example.com")
	created := a.Do(http.MethodPost, "/api/devices", cookie, map[string]any{"name": "Kiosk"})
	id := created.JSON["device"].(map[string]any)["id"].(string)
	if _, err := a.Rig.Pool.Exec(context.Background(), `
		UPDATE "device" SET "token_hash" = 't', "pin_hash" = 'p', "enrolled_at" = now(),
			"enrol_code_hash" = NULL, "enrol_expires_at" = NULL
		WHERE "id" = $1`, id); err != nil {
		t.Fatalf("enrol: %v", err)
	}

	res := a.Do(http.MethodPost, "/api/devices/"+id+"/code", cookie, nil)
	if res.Status != http.StatusConflict || res.JSON["code"] != "ALREADY_ENROLLED" {
		t.Errorf("renew an enrolled device = %d %v, want 409 ALREADY_ENROLLED", res.Status, res.JSON)
	}
	list := a.DoArray(http.MethodGet, "/api/devices", cookie, nil)
	if len(list.JSON) != 1 || list.JSON[0].(map[string]any)["status"] != "active" {
		t.Errorf("list = %v, want the one device, active", list.JSON)
	}
}

func TestDeviceAdminIsFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	_, cookieA := a.NewFamily("Hansen", "anne@example.com")
	_, cookieB := a.NewFamily("Nordmann", "ola@example.com")
	created := a.Do(http.MethodPost, "/api/devices", cookieA, map[string]any{"name": "Kiosk"})
	id := created.JSON["device"].(map[string]any)["id"].(string)

	if res := a.Do(http.MethodPost, "/api/devices/"+id+"/code", cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("renew another family's device = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/devices/"+id, cookieB, nil); res.Status != http.StatusNotFound {
		t.Errorf("revoke another family's device = %d, want 404", res.Status)
	}
	if list := a.DoArray(http.MethodGet, "/api/devices", cookieB, nil); len(list.JSON) != 0 {
		t.Errorf("family B lists %v, want nothing of family A's", list.JSON)
	}
}

func TestDeviceAdminRefusesMembersAndKeys(t *testing.T) {
	a := testrig.App(t)
	familyID, _ := a.NewFamily("Hansen", "anne@example.com")
	memberID := a.SignUp("Bo", "bo@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "bo@example.com")

	if res := a.Do(http.MethodPost, "/api/devices", memberCookie, map[string]any{"name": "Kiosk"}); res.Status != http.StatusForbidden {
		t.Errorf("create as a member = %d, want 403", res.Status)
	}

	key := a.CreateAPIKey(familyID, deviceUserID(t, a, "anne@example.com"))
	req := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	if res := a.DoRequest(req); res.Status != http.StatusForbidden {
		t.Errorf("list with an API key = %d, want 403", res.Status)
	}
}

func TestDeviceAdminCapsAtTen(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "anne@example.com")
	var first string
	for i := range 10 {
		res := a.Do(http.MethodPost, "/api/devices", cookie, map[string]any{"name": fmt.Sprintf("Kiosk %d", i)})
		if res.Status != http.StatusCreated {
			t.Fatalf("device %d = %d, want 201", i, res.Status)
		}
		if i == 0 {
			first = res.JSON["device"].(map[string]any)["id"].(string)
		}
	}
	res := a.Do(http.MethodPost, "/api/devices", cookie, map[string]any{"name": "One too many"})
	if res.Status != http.StatusConflict || res.JSON["code"] != "DEVICE_LIMIT" {
		t.Errorf("11th device = %d %v, want 409 DEVICE_LIMIT", res.Status, res.JSON)
	}
	a.Do(http.MethodDelete, "/api/devices/"+first, cookie, nil)
	if res := a.Do(http.MethodPost, "/api/devices", cookie, map[string]any{"name": "Replacement"}); res.Status != http.StatusCreated {
		t.Errorf("after revoking one = %d, want 201 (revoked devices do not count)", res.Status)
	}
}

func TestDeviceAdminValidatesTheName(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "anne@example.com")
	for _, name := range []string{"", "   ", strings.Repeat("x", 61)} {
		if res := a.Do(http.MethodPost, "/api/devices", cookie, map[string]any{"name": name}); res.Status != http.StatusBadRequest {
			t.Errorf("name %q = %d, want 400", name, res.Status)
		}
	}
}
