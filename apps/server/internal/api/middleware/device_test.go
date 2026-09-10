package middleware_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/auth"
)

// -------------------------------------------------------------------------
// Kiosk devices (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md
// §2 and §4): the pjokk_device cookie, the caretaker header, and the admin
// refusal.
// -------------------------------------------------------------------------

// deviceOpts describes a device to insert. Zero values mean "an ordinary,
// active device that has never been used".
type deviceOpts struct {
	revoked  bool
	lastUsed *time.Time
}

// createDevice inserts an ACTIVE device row and returns the plaintext token
// the tablet's cookie would carry. Only its SHA-256 is stored.
func (f *fixture) createDevice(familyID, createdBy string, opts deviceOpts) string {
	f.t.Helper()

	token := "pjd_" + strings.ReplaceAll(familyID, "-", "")
	sum := sha256.Sum256([]byte(token))
	var revokedAt *time.Time
	if opts.revoked {
		now := time.Now()
		revokedAt = &now
	}
	f.exec(`
		INSERT INTO "device"
			("family_id", "name", "created_by", "token_hash", "pin_hash",
			 "enrolled_at", "last_used_at", "revoked_at")
		VALUES ($1, 'Kitchen tablet', $2, $3, 'x', now(), $4, $5)`,
		familyID, createdBy, hex.EncodeToString(sum[:]), opts.lastUsed, revokedAt,
	)
	return token
}

// deviceFamily is a family whose admin enrolled the device.
func (f *fixture) deviceFamily() (familyID, adminID string) {
	f.t.Helper()
	adminID, cookie := f.signIn("Anne", "anne@example.com")
	familyID = f.family(adminID, cookie.Value, "Hansen")
	return familyID, adminID
}

// deviceChain is the production order for a family route: DeviceAuth ahead
// of Session, then RequireFamily, then whatever tail the test adds.
func (f *fixture) deviceChain(p *probe, tail ...func(http.Handler) http.Handler) http.Handler {
	var h http.Handler = p.handler()
	for i := len(tail) - 1; i >= 0; i-- {
		h = tail[i](h)
	}
	return middleware.DeviceAuth(f.deps)(middleware.Session(f.deps)(middleware.RequireFamily(f.deps)(h)))
}

func deviceRequest(method, token, caretaker string) *http.Request {
	req := httptest.NewRequest(method, "/probe", nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: middleware.DeviceCookieName, Value: token})
	}
	if caretaker != "" {
		req.Header.Set(middleware.CaretakerHeader, caretaker)
	}
	return req
}

func deviceCookieIn(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == middleware.DeviceCookieName {
			return c
		}
	}
	return nil
}

func TestDeviceAuthResolvesTheDevicesFamily(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	token := f.createDevice(familyID, adminID, deviceOpts{})

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodGet, token, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	fam := p.family
	if fam.FamilyID != familyID || !fam.IsDevice || fam.DeviceID == "" {
		t.Errorf("family = %+v, want the device's family marked IsDevice with a DeviceID", fam)
	}
	if fam.UserID != "" {
		t.Errorf("UserID = %q, want empty on a read without a caretaker", fam.UserID)
	}
	if fam.MemberRole != auth.RoleMember {
		t.Errorf("MemberRole = %q, want %q", fam.MemberRole, auth.RoleMember)
	}
	if p.session != nil {
		t.Errorf("a device request resolved a session: %+v", p.session)
	}
}

func TestDeviceAuthRejectsARevokedDeviceAndClearsTheCookie(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	token := f.createDevice(familyID, adminID, deviceOpts{revoked: true})

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodGet, token, ""))

	assertRejected(t, rec, p, http.StatusUnauthorized, "DEVICE_REVOKED")
	c := deviceCookieIn(rec)
	if c == nil || c.MaxAge >= 0 || c.Value != "" {
		t.Errorf("cookie = %+v, want %s cleared (Max-Age=0) so the sign-in screen does not loop", c, middleware.DeviceCookieName)
	}
}

func TestDeviceAuthRejectsAnUnknownToken(t *testing.T) {
	f := newFixture(t)

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodGet, "pjd_never-issued", ""))

	assertRejected(t, rec, p, http.StatusUnauthorized, "DEVICE_REVOKED")
}

func TestDeviceAuthPassesThroughWithoutACookie(t *testing.T) {
	f := newFixture(t)

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodGet, "", ""))

	// Untouched by DeviceAuth: RequireFamily's own anonymous answer.
	assertRejected(t, rec, p, http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestDeviceWriteRequiresACaretaker(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	token := f.createDevice(familyID, adminID, deviceOpts{})

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodPost, token, ""))

	assertRejected(t, rec, p, http.StatusBadRequest, "CARETAKER_REQUIRED")
}

func TestDeviceCaretakerMustBeAMember(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	token := f.createDevice(familyID, adminID, deviceOpts{})
	outsiderID, outsiderCookie := f.signIn("Ola", "ola@example.com")
	f.family(outsiderID, outsiderCookie.Value, "Nordmann")

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodPost, token, outsiderID))

	assertRejected(t, rec, p, http.StatusForbidden, "NOT_MEMBER")
}

func TestDeviceCaretakerBecomesTheUserButNeverAnAdmin(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	token := f.createDevice(familyID, adminID, deviceOpts{})
	memberID, _ := f.signIn("Bo", "bo@example.com")
	if err := f.svc.AddMember(f.ctx, familyID, memberID, auth.RoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	for _, caretaker := range []string{memberID, adminID} {
		p := &probe{}
		rec := httptest.NewRecorder()
		f.deviceChain(p).ServeHTTP(rec, deviceRequest(http.MethodPost, token, caretaker))

		if rec.Code != http.StatusOK {
			t.Fatalf("caretaker %s: status = %d, want 200 (body %s)", caretaker, rec.Code, rec.Body.String())
		}
		if p.family.UserID != caretaker {
			t.Errorf("UserID = %q, want the caretaker %q", p.family.UserID, caretaker)
		}
		if p.family.MemberRole != auth.RoleMember {
			t.Errorf("caretaker %s: MemberRole = %q, want %q — choosing yourself grants nothing",
				caretaker, p.family.MemberRole, auth.RoleMember)
		}
	}
}

func TestRequireAdminRejectsDevices(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	token := f.createDevice(familyID, adminID, deviceOpts{})

	p := &probe{}
	rec := httptest.NewRecorder()
	f.deviceChain(p, middleware.RequireAdmin()).ServeHTTP(rec, deviceRequest(http.MethodPost, token, adminID))

	assertRejected(t, rec, p, http.StatusForbidden, "FORBIDDEN")
}

func TestDeviceCookieIsReissuedOncePerDay(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	yesterday := time.Now().Add(-25 * time.Hour)
	token := f.createDevice(familyID, adminID, deviceOpts{lastUsed: &yesterday})

	rec := httptest.NewRecorder()
	f.deviceChain(&probe{}).ServeHTTP(rec, deviceRequest(http.MethodGet, token, ""))
	c := deviceCookieIn(rec)
	if c == nil || c.Value != token || c.MaxAge != 400*24*60*60 {
		t.Fatalf("first use of the day: cookie = %+v, want the token re-issued with Max-Age 400 days", c)
	}

	// last_used_at was just touched: the next request is inside the
	// five-minute window and re-issues nothing.
	rec = httptest.NewRecorder()
	f.deviceChain(&probe{}).ServeHTTP(rec, deviceRequest(http.MethodGet, token, ""))
	if c := deviceCookieIn(rec); c != nil {
		t.Errorf("second request: cookie = %+v, want none", c)
	}
}

func TestAPIKeyWinsOverADeviceCookie(t *testing.T) {
	f := newFixture(t)
	familyID, adminID := f.deviceFamily()
	deviceToken := f.createDevice(familyID, adminID, deviceOpts{})
	key := f.createAPIKey(familyID, adminID, apiKeyOpts{})

	p := &probe{}
	req := deviceRequest(http.MethodGet, deviceToken, "")
	req.Header.Set("Authorization", "Bearer "+key)
	rec := httptest.NewRecorder()
	middleware.APIKeyAuth(f.deps)(f.deviceChain(p)).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if !p.family.IsAPIKey || p.family.IsDevice {
		t.Errorf("family = %+v, want the API key's identity, not the device's", p.family)
	}
}

func TestDeviceCookieAttributes(t *testing.T) {
	rec := httptest.NewRecorder()
	middleware.SetDeviceCookie(rec, "pjd_token", true)
	c := deviceCookieIn(rec)
	if c == nil {
		t.Fatal("SetDeviceCookie set no cookie")
	}
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.MaxAge != 400*24*60*60 {
		t.Errorf("cookie = %+v, want HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age 400 days", c)
	}

	rec = httptest.NewRecorder()
	middleware.SetDeviceCookie(rec, "pjd_token", false)
	if c := deviceCookieIn(rec); c == nil || c.Secure {
		t.Errorf("cookie over plain http = %+v, want Secure off", c)
	}

	rec = httptest.NewRecorder()
	middleware.ClearDeviceCookie(rec, true)
	if c := deviceCookieIn(rec); c == nil || c.MaxAge >= 0 {
		t.Errorf("cleared cookie = %+v, want Max-Age=0", c)
	}
}
