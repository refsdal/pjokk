package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Settings → Family → Devices: the family-admin surface for kiosk devices
// (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md §5). An admin
// adds a device and gets a one-time code; a tablet redeems it on
// /kiosk/setup (device_self.go) and from then on authenticates with a cookie
// of its own. Everything here runs behind tierAdmin, which already refuses
// API keys and devices.

// deviceCodeTTL is how long a set-up code works: long enough to walk from
// the phone to the tablet, short enough that a code photographed off a
// screen is useless by the time anyone thinks to try it.
const deviceCodeTTL = 15 * time.Minute

// maxDevicesPerFamily caps pending plus active devices. A sanity limit, not
// a quota: checked before the insert without a lock, so two admins racing
// the tenth device can land an eleventh — harmless, and not worth a
// transaction on a path that runs a handful of times per family.
const maxDevicesPerFamily = 10

// newDeviceCode returns a fresh set-up code, its SHA-256 (all the database
// ever holds) and when it stops working. The code reuses the invite-code
// generator: same alphabet (no 0/O/1/I/L — it is read off one screen and
// typed on another), same length.
func (d Deps) newDeviceCode() (code, hash string, expires time.Time, err error) {
	code, err = generateInviteCode()
	if err != nil {
		return "", "", time.Time{}, err
	}
	return code, sha256Hex(code), d.Now().Add(deviceCodeTTL), nil
}

// serDevice converts a device row to its wire shape. Never includes the
// code, the token or the PIN — only their consequences (status, expiry).
func serDevice(row dbgen.ListDevicesRow) gen.Device {
	out := gen.Device{
		Id:            row.ID,
		Name:          row.Name,
		Status:        gen.Pending,
		CreatedAt:     row.CreatedAt.Time,
		CreatedByName: row.CreatedByName,
		EnrolledAt:    tsPtr(row.EnrolledAt),
		LastUsedAt:    tsPtr(row.LastUsedAt),
		CodeExpiresAt: tsPtr(row.EnrolExpiresAt),
	}
	if row.TokenHash != nil {
		out.Status = gen.Active
		out.CodeExpiresAt = nil
	}
	return out
}

// deviceCode is the one response that carries a code, with the set-up URL
// the Settings QR encodes.
func (d Deps) deviceCode(ctx context.Context, familyID, deviceID, code string, expires time.Time) (gen.DeviceCode, error) {
	row, err := d.Q.GetDevice(ctx, dbgen.GetDeviceParams{ID: deviceID, FamilyID: familyID})
	if err != nil {
		return gen.DeviceCode{}, err
	}
	return gen.DeviceCode{
		Device:    serDevice(dbgen.ListDevicesRow(row)),
		Code:      code,
		ExpiresAt: expires,
		SetupUrl:  strings.TrimRight(d.AppURL, "/") + "/kiosk/setup?code=" + code,
	}, nil
}

// ListDevices implements GET /api/devices: pending and active devices,
// newest first (queries/devices.sql's ListDevices).
func (d Deps) ListDevices(ctx context.Context, _ gen.ListDevicesRequestObject) (gen.ListDevicesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListDevices(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.Device, len(rows))
	for i, row := range rows {
		out[i] = serDevice(row)
	}
	return gen.ListDevices200JSONResponse(out), nil
}

// CreateDevice implements POST /api/devices: a pending device and its
// one-time code, shown exactly once.
func (d Deps) CreateDevice(ctx context.Context, req gen.CreateDeviceRequestObject) (gen.CreateDeviceResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateDevice")
	}
	name := strings.TrimSpace(req.Body.Name)
	if name == "" {
		return gen.CreateDevice400JSONResponse(gen.Error{Error: "A device needs a name", Code: "VALIDATION"}), nil
	}

	n, err := d.Q.CountActiveDevices(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	if n >= maxDevicesPerFamily {
		return gen.CreateDevice409JSONResponse(gen.Error{
			Error: "A family can have at most 10 devices",
			Code:  "DEVICE_LIMIT",
		}), nil
	}

	code, hash, expires, err := d.newDeviceCode()
	if err != nil {
		return nil, err
	}
	row, err := d.Q.CreateDevice(ctx, dbgen.CreateDeviceParams{
		FamilyID:       fam.FamilyID,
		Name:           name,
		CreatedBy:      fam.UserID,
		EnrolCodeHash:  &hash,
		EnrolExpiresAt: ts(expires),
	})
	if err != nil {
		return nil, err
	}
	out, err := d.deviceCode(ctx, fam.FamilyID, row.ID, code, expires)
	if err != nil {
		return nil, err
	}
	return gen.CreateDevice201JSONResponse(out), nil
}

// RenewDeviceCode implements POST /api/devices/{id}/code: a fresh code for
// a device that has not been set up yet. The old code's hash is overwritten,
// so it stops working at once.
func (d Deps) RenewDeviceCode(ctx context.Context, req gen.RenewDeviceCodeRequestObject) (gen.RenewDeviceCodeResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	code, hash, expires, err := d.newDeviceCode()
	if err != nil {
		return nil, err
	}
	n, err := d.Q.RenewDeviceCode(ctx, dbgen.RenewDeviceCodeParams{
		ID:             req.Id,
		FamilyID:       fam.FamilyID,
		EnrolCodeHash:  &hash,
		EnrolExpiresAt: ts(expires),
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		// Unknown, revoked or already enrolled: only the last is a 409.
		row, err := d.Q.GetDevice(ctx, dbgen.GetDeviceParams{ID: req.Id, FamilyID: fam.FamilyID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return gen.RenewDeviceCode404JSONResponse(notFound()), nil
		case err != nil:
			return nil, err
		case row.RevokedAt.Valid:
			return gen.RenewDeviceCode404JSONResponse(notFound()), nil
		}
		return gen.RenewDeviceCode409JSONResponse(gen.Error{
			Error: "This device is already set up",
			Code:  "ALREADY_ENROLLED",
		}), nil
	}
	out, err := d.deviceCode(ctx, fam.FamilyID, req.Id, code, expires)
	if err != nil {
		return nil, err
	}
	return gen.RenewDeviceCode200JSONResponse(out), nil
}

// RevokeDevice implements DELETE /api/devices/{id}. Soft-delete, like
// RevokeApiKey: the tablet's cookie stops working on its next request, and
// revoking twice (or another family's id) is a 404.
func (d Deps) RevokeDevice(ctx context.Context, req gen.RevokeDeviceRequestObject) (gen.RevokeDeviceResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.RevokeDevice(ctx, dbgen.RevokeDeviceParams{
		ID:        req.Id,
		FamilyID:  fam.FamilyID,
		RevokedAt: ts(d.Now()),
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.RevokeDevice404JSONResponse(notFound()), nil
	}
	return gen.RevokeDevice204Response{}, nil
}
