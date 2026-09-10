package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/respond"
	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// Kiosk devices (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md
// §2 and §4). A tablet enrolled as the family's care station authenticates
// with a cookie of its own rather than a person's session; RequireFamily
// then turns the device plus an X-Pjokk-Caretaker header into the tenancy
// context, and the operation allowlist in internal/api decides what it may
// call at all.

// DeviceCookieName is the device credential's cookie. HttpOnly, so page
// script never sees it; a cookie rather than a bearer header because the
// kiosk loads avatars through <img src>, which cannot send one.
const DeviceCookieName = "pjokk_device"

// CaretakerHeader names who is logging on a kiosk: attribution only. It is
// validated as a member of the device's family and grants nothing — the
// role under a device is always "member".
const CaretakerHeader = "X-Pjokk-Caretaker"

// deviceCookieMaxAge is 400 days, the ceiling browsers apply to any cookie.
// DeviceAuth re-issues the cookie once a day, so a kiosk in use never
// expires; one left unused for more than 400 days has to be enrolled again.
const deviceCookieMaxAge = 400 * 24 * 60 * 60

// Device is the resolved kiosk behind a request.
type Device struct {
	ID         string
	FamilyID   string
	Name       string
	FamilyName string
	// TokenHash is the SHA-256 hex of the cookie's token — also the salt of
	// the device's PIN HMAC (internal/api's devicePINHash).
	TokenHash string
}

// DeviceFromContext returns the device DeviceAuth resolved, or nil.
func DeviceFromContext(ctx context.Context) *Device {
	id, _ := ctx.Value(identityKey).(identity)
	return id.device
}

// IsDevice reports whether this request was authenticated by a device cookie.
func IsDevice(r *http.Request) bool {
	return DeviceFromContext(r.Context()) != nil
}

// SetDeviceCookie writes the device credential. secure follows APP_URL's
// scheme, the same rule Limen's session cookie uses.
func SetDeviceCookie(w http.ResponseWriter, token string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     DeviceCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   deviceCookieMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearDeviceCookie expires the device credential in the browser.
func ClearDeviceCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     DeviceCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// DeviceAuth resolves the pjokk_device cookie. Mounted after APIKeyAuth (a
// pjk_ bearer still wins) and before Session (so a device request never
// resolves a person's session, even if the browser somehow carries one).
//
// A request without the cookie passes through untouched. A cookie whose
// token is unknown or revoked is answered 401 DEVICE_REVOKED and the cookie
// is cleared in the same response: the kiosk treats that code as "go to
// sign-in", and a stale cookie left behind would follow it there.
func DeviceAuth(d Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := identityFrom(r); ok {
				next.ServeHTTP(w, r)
				return
			}
			c, err := r.Cookie(DeviceCookieName)
			if err != nil || c.Value == "" {
				next.ServeHTTP(w, r)
				return
			}

			sum := sha256.Sum256([]byte(c.Value))
			tokenHash := hex.EncodeToString(sum[:])
			row, err := d.Q.GetDeviceByTokenHash(r.Context(), &tokenHash)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				ClearDeviceCookie(w, d.SecureCookies)
				respond.Error(w, http.StatusUnauthorized, "This device is no longer a kiosk", "DEVICE_REVOKED")
				return
			case err != nil:
				respond.Error(w, http.StatusInternalServerError, "device lookup failed", "INTERNAL")
				return
			}

			now := d.now()
			if !row.LastUsedAt.Valid || now.Sub(row.LastUsedAt.Time) > lastUsedInterval {
				// Best-effort, like APIKeyAuth: a failed bookkeeping write must
				// not stop a kiosk from logging a feed.
				if err := d.Q.TouchDevice(r.Context(), gen.TouchDeviceParams{
					ID:         row.ID,
					LastUsedAt: pgtype.Timestamptz{Time: now, Valid: true},
				}); err != nil {
					log.Printf("middleware: device last_used_at update failed (device=%s): %v", row.ID, err)
				}
				// The first touch of each UTC day re-issues the cookie with a
				// fresh Max-Age — at most once a day, never per request.
				if !row.LastUsedAt.Valid || !sameUTCDay(row.LastUsedAt.Time, now) {
					SetDeviceCookie(w, c.Value, d.SecureCookies)
				}
			}

			dev := &Device{
				ID:         row.ID,
				FamilyID:   row.FamilyID,
				Name:       row.Name,
				FamilyName: row.FamilyName,
				TokenHash:  tokenHash,
			}
			next.ServeHTTP(w, withIdentity(r, identity{device: dev}))
		})
	}
}

// RequireDevice gates the device's own routes (GET /api/device and friends):
// anyone who is not an enrolled device gets 401 NOT_A_DEVICE, which the
// kiosk reads as "this browser was a kiosk the old way".
func RequireDevice() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !IsDevice(r) {
				respond.Error(w, http.StatusUnauthorized, "Not a kiosk device", "NOT_A_DEVICE")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func sameUTCDay(a, b time.Time) bool {
	ay, am, ad := a.UTC().Date()
	by, bm, bd := b.UTC().Date()
	return ay == by && am == bm && ad == bd
}
