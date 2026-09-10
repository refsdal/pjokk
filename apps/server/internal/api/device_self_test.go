package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// The tablet's side of kiosk devices (docs/superpowers/specs/
// 2026-09-10-kiosk-devices-design.md §3 and §5): redeeming the one-time
// code, the device's own reads, and leaving with the PIN.
// -----------------------------------------------------------------------

const testPIN = "2468"

// addDevice creates a pending device as the family admin and returns its id
// and one-time code.
func addDevice(t *testing.T, a *testrig.AppRig, adminCookie string) (id, code string) {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/devices", adminCookie, map[string]any{"name": "Kitchen tablet"})
	if res.Status != http.StatusCreated {
		t.Fatalf("create device = %d (body %s)", res.Status, res.Raw)
	}
	return res.JSON["device"].(map[string]any)["id"].(string), res.JSON["code"].(string)
}

func enrol(a *testrig.AppRig, code, pin string) *testrig.Result {
	return a.Do(http.MethodPost, "/api/device/enrol", "", map[string]any{"code": code, "pin": pin})
}

// deviceCookie finds pjokk_device among a response's Set-Cookie headers.
func deviceCookie(res *testrig.Result) *http.Cookie {
	for _, c := range (&http.Response{Header: res.Header}).Cookies() {
		if c.Name == "pjokk_device" {
			return c
		}
	}
	return nil
}

// enrolledDevice adds a device and enrols it, returning the Cookie header
// value a tablet would send from then on.
func enrolledDevice(t *testing.T, a *testrig.AppRig, adminCookie string) string {
	t.Helper()
	_, code := addDevice(t, a, adminCookie)
	res := enrol(a, code, testPIN)
	c := deviceCookie(res)
	if res.Status != http.StatusOK || c == nil {
		t.Fatalf("enrol = %d, cookie %v (body %s)", res.Status, c, res.Raw)
	}
	return "pjokk_device=" + c.Value
}

func TestDeviceEnrolSetsTheCookieOnce(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	id, code := addDevice(t, a, admin)

	res := enrol(a, code, testPIN)
	if res.Status != http.StatusOK {
		t.Fatalf("enrol = %d, want 200 (body %s)", res.Status, res.Raw)
	}
	if res.JSON["id"] != id || res.JSON["name"] != "Kitchen tablet" || res.JSON["familyName"] != "Hansen" {
		t.Errorf("enrol body = %v, want this device in family Hansen", res.JSON)
	}
	c := deviceCookie(res)
	if c == nil || !strings.HasPrefix(c.Value, "pjd_") || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.MaxAge != 400*24*60*60 {
		t.Fatalf("cookie = %+v, want an HttpOnly, SameSite=Lax pjd_ token for 400 days", c)
	}

	self := a.Do(http.MethodGet, "/api/device", "pjokk_device="+c.Value, nil)
	if self.Status != http.StatusOK || self.JSON["id"] != id {
		t.Errorf("GET /api/device = %d %v, want this device", self.Status, self.JSON)
	}

	if again := enrol(a, code, testPIN); again.Status != http.StatusBadRequest || again.JSON["code"] != "INVALID_CODE" {
		t.Errorf("second use of the code = %d %v, want 400 INVALID_CODE", again.Status, again.JSON)
	}
	list := a.DoArray(http.MethodGet, "/api/devices", admin, nil)
	if len(list.JSON) != 1 || list.JSON[0].(map[string]any)["status"] != "active" {
		t.Errorf("admin list = %v, want the device, active", list.JSON)
	}
}

func TestDeviceEnrolAcceptsALowercaseCode(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	_, code := addDevice(t, a, admin)
	if res := enrol(a, strings.ToLower(code), testPIN); res.Status != http.StatusOK {
		t.Errorf("enrol with %q = %d, want 200 (body %s)", strings.ToLower(code), res.Status, res.Raw)
	}
}

func TestDeviceEnrolRefusesAnExpiredCode(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	_, code := addDevice(t, a, admin)
	a.SetNow(time.Now().Add(16 * time.Minute))
	if res := enrol(a, code, testPIN); res.Status != http.StatusBadRequest || res.JSON["code"] != "INVALID_CODE" {
		t.Errorf("enrol after 16 minutes = %d %v, want 400 INVALID_CODE", res.Status, res.JSON)
	}
}

func TestDeviceEnrolRefusesADeviceRevokedBeforeSetUp(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	id, code := addDevice(t, a, admin)
	a.Do(http.MethodDelete, "/api/devices/"+id, admin, nil)
	if res := enrol(a, code, testPIN); res.Status != http.StatusBadRequest || res.JSON["code"] != "INVALID_CODE" {
		t.Errorf("enrol a revoked device = %d %v, want 400 INVALID_CODE", res.Status, res.JSON)
	}
}

func TestDeviceEnrolValidatesThePin(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	_, code := addDevice(t, a, admin)
	for _, pin := range []string{"12", "abcd", "1234567", ""} {
		if res := enrol(a, code, pin); res.Status != http.StatusBadRequest {
			t.Errorf("PIN %q = %d, want 400", pin, res.Status)
		}
	}
	// None of those consumed the code.
	if res := enrol(a, code, testPIN); res.Status != http.StatusOK {
		t.Errorf("enrol after bad PINs = %d, want 200 (body %s)", res.Status, res.Raw)
	}
}

func TestDeviceRoutesRefuseEveryoneButDevices(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	for _, cookie := range []string{admin, ""} {
		for _, path := range []string{"/api/device", "/api/device/thresholds"} {
			res := a.Do(http.MethodGet, path, cookie, nil)
			if res.Status != http.StatusUnauthorized || res.JSON["code"] != "NOT_A_DEVICE" {
				t.Errorf("GET %s with cookie %q = %d %v, want 401 NOT_A_DEVICE", path, cookie, res.Status, res.JSON)
			}
		}
	}
}

func TestDeviceUnenrolWithThePin(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	dev := enrolledDevice(t, a, admin)

	wrong := a.Do(http.MethodPost, "/api/device/unenrol", dev, map[string]any{"pin": "0000"})
	if wrong.Status != http.StatusForbidden || wrong.JSON["code"] != "WRONG_PIN" {
		t.Errorf("wrong PIN = %d %v, want 403 WRONG_PIN", wrong.Status, wrong.JSON)
	}

	right := a.Do(http.MethodPost, "/api/device/unenrol", dev, map[string]any{"pin": testPIN})
	if right.Status != http.StatusNoContent {
		t.Fatalf("right PIN = %d, want 204 (body %s)", right.Status, right.Raw)
	}
	if c := deviceCookie(right); c == nil || c.MaxAge >= 0 {
		t.Errorf("cookie after unenrol = %+v, want it cleared", c)
	}
	if res := a.Do(http.MethodGet, "/api/device", dev, nil); res.Status != http.StatusUnauthorized || res.JSON["code"] != "DEVICE_REVOKED" {
		t.Errorf("the old cookie afterwards = %d %v, want 401 DEVICE_REVOKED", res.Status, res.JSON)
	}
	if list := a.DoArray(http.MethodGet, "/api/devices", admin, nil); len(list.JSON) != 0 {
		t.Errorf("admin list after unenrol = %v, want empty", list.JSON)
	}
}

func TestDeviceUnenrolIsRateLimitedPerDevice(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	dev := enrolledDevice(t, a, admin)

	for i := range 5 {
		if res := a.Do(http.MethodPost, "/api/device/unenrol", dev, map[string]any{"pin": "0000"}); res.Status != http.StatusForbidden {
			t.Fatalf("wrong PIN %d = %d, want 403", i+1, res.Status)
		}
	}
	if res := a.Do(http.MethodPost, "/api/device/unenrol", dev, map[string]any{"pin": testPIN}); res.Status != http.StatusTooManyRequests {
		t.Errorf("sixth attempt = %d, want 429 even with the right PIN", res.Status)
	}
}

func TestDevicePinHashIsKeyedAndPerDevice(t *testing.T) {
	a := testrig.App(t)
	_, admin := a.NewFamily("Hansen", "anne@example.com")
	enrolledDevice(t, a, admin)
	enrolledDevice(t, a, admin)

	rows, err := a.Rig.Pool.Query(context.Background(), `SELECT "pin_hash" FROM "device" WHERE "pin_hash" IS NOT NULL`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var hashes []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			t.Fatalf("scan: %v", err)
		}
		hashes = append(hashes, h)
	}
	if len(hashes) != 2 {
		t.Fatalf("pin hashes = %v, want two", hashes)
	}
	if hashes[0] == hashes[1] {
		t.Errorf("the same PIN on two devices hashed alike (%s) — the HMAC must be per device", hashes[0])
	}
	for _, h := range hashes {
		if h == sha256Of(testPIN) || strings.Contains(h, testPIN) {
			t.Errorf("pin hash %q is a bare digest of the PIN, want a keyed HMAC", h)
		}
	}
}

func TestDeviceThresholds(t *testing.T) {
	a := testrig.App(t)
	familyID, admin := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	boID := a.SignUp("Bo", "bo@example.com")
	bo := a.AddMember(familyID, boID, auth.RoleMember, "bo@example.com")
	_, other := a.NewFamily("Nordmann", "ola@example.com")

	remind := func(cookie string, body map[string]any) {
		t.Helper()
		body["tz"] = "Europe/Oslo"
		if res := a.Do(http.MethodPost, "/api/reminders", cookie, body); res.Status != http.StatusCreated {
			t.Fatalf("create reminder %v = %d (body %s)", body, res.Status, res.Raw)
		}
	}
	remind(admin, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 180})
	remind(admin, map[string]any{"kind": "diaper", "mode": "since_last", "intervalMin": 240, "babyId": babyID})
	remind(admin, map[string]any{"kind": "feed", "mode": "at_time", "atMinute": 480})
	remind(admin, map[string]any{"kind": "pump", "mode": "since_last", "intervalMin": 120})
	remind(bo, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 150})
	remind(other, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 60})

	dev := enrolledDevice(t, a, admin)
	res := a.DoArray(http.MethodGet, "/api/device/thresholds", dev, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("thresholds = %d, want 200 (body %s)", res.Status, res.Raw)
	}
	want := []map[string]any{
		{"kind": "diaper", "babyId": babyID, "intervalMin": float64(240)},
		{"kind": "feed", "babyId": nil, "intervalMin": float64(150)},
		{"kind": "feed", "babyId": nil, "intervalMin": float64(180)},
	}
	if len(res.JSON) != len(want) {
		t.Fatalf("thresholds = %v, want %v", res.JSON, want)
	}
	for i, w := range want {
		got := res.JSON[i].(map[string]any)
		for k, v := range w {
			if got[k] != v {
				t.Errorf("threshold %d %s = %v, want %v (all: %v)", i, k, got[k], v, res.JSON)
			}
		}
		if len(got) != 3 {
			t.Errorf("threshold %d = %v, want exactly kind, babyId and intervalMin", i, got)
		}
	}
}
