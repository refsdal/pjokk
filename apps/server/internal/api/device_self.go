package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// The tablet's side of kiosk devices (docs/superpowers/specs/
// 2026-09-10-kiosk-devices-design.md §3 and §5): redeeming the one-time
// code from devices.go, the device's own reads, and leaving with the PIN.

// deviceTokenPrefix marks a device token, as pjk_ marks an API key. The
// token only ever travels in the HttpOnly pjokk_device cookie.
const deviceTokenPrefix = "pjd_"

// deviceTokenRandomBytes is the API-key recipe: 160 bits of crypto/rand, so
// a fast SHA-256 at rest is enough (see keys.go's sha256Hex comment).
const deviceTokenRandomBytes = 20

// Leaving with the PIN: five attempts per device per ten minutes, keyed on
// the device rather than the client — the tablet is the thing being guessed
// at, from wherever.
const (
	unenrolAttempts      = 5
	unenrolWindowSeconds = 600
)

func generateDeviceToken() (string, error) {
	buf := make([]byte, deviceTokenRandomBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("api: generate device token: %w", err)
	}
	return deviceTokenPrefix + hex.EncodeToString(buf), nil
}

// devicePINHash is how a device's PIN is stored: an HMAC keyed from
// AUTH_SECRET (Deps.DevicePINKey), salted with the device's token hash. The
// key is what makes a 4–6 digit PIN unrecoverable from a leaked row; the
// salt makes the same PIN on two tablets two different hashes. The token
// hash rather than the device id because it exists before the one-statement
// enrolment that creates the pairing, and never changes after it.
func devicePINHash(key [32]byte, tokenHash, pin string) string {
	mac := hmac.New(sha256.New, key[:])
	mac.Write([]byte("device-pin:" + tokenHash + ":" + pin))
	return hex.EncodeToString(mac.Sum(nil))
}

func (d Deps) secureCookies() bool {
	return strings.HasPrefix(d.AppURL, "https://")
}

// EnrolDevice implements POST /api/device/enrol: redeem the code, store the
// token and PIN hashes, set the cookie. Unknown, expired and already-used
// codes are one answer, so a guesser learns nothing from which it was.
func (d Deps) EnrolDevice(ctx context.Context, req gen.EnrolDeviceRequestObject) (gen.EnrolDeviceResponseObject, error) {
	if req.Body == nil {
		return nil, errNoRequestBody("EnrolDevice")
	}
	token, err := generateDeviceToken()
	if err != nil {
		return nil, err
	}
	tokenHash := sha256Hex(token)
	codeHash := sha256Hex(strings.ToUpper(strings.TrimSpace(req.Body.Code)))
	pinHash := devicePINHash(d.DevicePINKey, tokenHash, req.Body.Pin)

	row, err := d.Q.EnrolDevice(ctx, dbgen.EnrolDeviceParams{
		TokenHash: &tokenHash,
		PinHash:   &pinHash,
		Now:       ts(d.Now()),
		CodeHash:  &codeHash,
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.EnrolDevice400JSONResponse(gen.Error{
			Error: "That code is not valid. Ask for a new one.",
			Code:  "INVALID_CODE",
		}), nil
	case err != nil:
		return nil, err
	}

	w, _, ok := middleware.HTTPFromContext(ctx)
	if !ok {
		return nil, errors.New("api: EnrolDevice reached without CaptureHTTP (publicNeedsHTTP?)")
	}
	middleware.SetDeviceCookie(w, token, d.secureCookies())
	return gen.EnrolDevice200JSONResponse{
		Id:         row.ID,
		Name:       row.Name,
		FamilyId:   row.FamilyID,
		FamilyName: row.FamilyName,
	}, nil
}

// requestDevice is the device tierDevice guarantees.
func requestDevice(ctx context.Context, op string) (*middleware.Device, error) {
	dev := middleware.DeviceFromContext(ctx)
	if dev == nil {
		return nil, fmt.Errorf("api: %s reached without a device (tierDevice not wired?)", op)
	}
	return dev, nil
}

// GetDevice implements GET /api/device: what the kiosk's DeviceGate reads.
func (d Deps) GetDevice(ctx context.Context, _ gen.GetDeviceRequestObject) (gen.GetDeviceResponseObject, error) {
	dev, err := requestDevice(ctx, "GetDevice")
	if err != nil {
		return nil, err
	}
	return gen.GetDevice200JSONResponse{
		Id:         dev.ID,
		Name:       dev.Name,
		FamilyId:   dev.FamilyID,
		FamilyName: dev.FamilyName,
	}, nil
}

// UnenrolDevice implements POST /api/device/unenrol: the kiosk's "leave"
// (spec §6) — with the right PIN the device is revoked and its cookie
// cleared, exactly as if an admin had revoked it.
func (d Deps) UnenrolDevice(ctx context.Context, req gen.UnenrolDeviceRequestObject) (gen.UnenrolDeviceResponseObject, error) {
	dev, err := requestDevice(ctx, "UnenrolDevice")
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("UnenrolDevice")
	}

	// Wall clock for the window, as middleware.RateLimit does: the window
	// number is shared by every replica.
	window := time.Now().Unix() / unenrolWindowSeconds
	count, err := d.RateLimit.Hit(ctx, fmt.Sprintf("rl:device-unenrol:%s:%d", dev.ID, window), unenrolWindowSeconds)
	if err != nil {
		return nil, err
	}
	if count > unenrolAttempts {
		return gen.UnenrolDevice429JSONResponse(gen.Error{
			Error: "Too many attempts, try again later",
			Code:  "RATE_LIMITED",
		}), nil
	}

	stored, err := d.Q.GetDevicePinHash(ctx, dbgen.GetDevicePinHashParams{ID: dev.ID, FamilyID: dev.FamilyID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Revoked between DeviceAuth and here.
		return gen.UnenrolDevice401JSONResponse(gen.Error{Error: "This device is no longer a kiosk", Code: "DEVICE_REVOKED"}), nil
	case err != nil:
		return nil, err
	}
	want := devicePINHash(d.DevicePINKey, dev.TokenHash, req.Body.Pin)
	if !hmac.Equal([]byte(stored), []byte(want)) {
		return gen.UnenrolDevice403JSONResponse(gen.Error{Error: "Wrong PIN", Code: "WRONG_PIN"}), nil
	}

	if _, err := d.Q.RevokeDevice(ctx, dbgen.RevokeDeviceParams{
		ID:        dev.ID,
		FamilyID:  dev.FamilyID,
		RevokedAt: ts(d.Now()),
	}); err != nil {
		return nil, err
	}
	w, _, ok := middleware.HTTPFromContext(ctx)
	if !ok {
		return nil, errors.New("api: UnenrolDevice reached without CaptureHTTP (tierDevice wiring?)")
	}
	middleware.ClearDeviceCookie(w, d.secureCookies())
	return gen.UnenrolDevice204Response{}, nil
}

// ListDeviceThresholds implements GET /api/device/thresholds: the amber
// card's intervals, from every caretaker in the device's family (spec §5,
// "Why thresholds exists").
func (d Deps) ListDeviceThresholds(ctx context.Context, _ gen.ListDeviceThresholdsRequestObject) (gen.ListDeviceThresholdsResponseObject, error) {
	dev, err := requestDevice(ctx, "ListDeviceThresholds")
	if err != nil {
		return nil, err
	}
	rows, err := d.Q.ListFamilyReminderThresholds(ctx, dev.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.DeviceThreshold, len(rows))
	for i, row := range rows {
		out[i] = gen.DeviceThreshold{
			Kind:        gen.DeviceThresholdKind(row.Kind),
			BabyId:      row.BabyID,
			IntervalMin: row.IntervalMin,
		}
	}
	return gen.ListDeviceThresholds200JSONResponse(out), nil
}
