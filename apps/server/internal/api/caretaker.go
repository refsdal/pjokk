package api

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Who did the care versus who saved the row (spec
// docs/superpowers/specs/2026-09-14-who-did-it-design.md). Every log row
// carries two people: caretaker_id, the one who did the care — what the
// timeline, the export and the kiosk show — and logged_by_id, the one who
// saved the row. A create body may name the caretaker; nothing a client
// sends can name the logger, which is always the family context's user: the
// session user, the API key's owner, or the kiosk's chosen caretaker.
//
// The rule lives here, once, so eleven create handlers, eleven PATCH
// handlers and the timer share it rather than each carrying a copy.

// caretakerFor resolves the caretaker_id for a write. wanted is the body's
// optional caretakerId: absent means the family context's user. Anyone
// named must hold a membership row in the family — the same check
// middleware.DeviceAuth runs on a kiosk's caretaker header — and notMember
// reports one who does not, which the handler answers with 403 NOT_MEMBER
// (notMemberErr). Naming yourself is allowed and costs no lookup.
func caretakerFor(ctx context.Context, d Deps, fam middleware.FamilyCtx, wanted *string) (id string, notMember bool, err error) {
	if wanted == nil || *wanted == fam.UserID {
		return fam.UserID, false, nil
	}
	if _, err := d.Q.GetFamilyMembershipRole(ctx, dbgen.GetFamilyMembershipRoleParams{
		OrganizationID: fam.FamilyID,
		UserID:         *wanted,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", true, nil
		}
		return "", false, err
	}
	return *wanted, false, nil
}

// caretakerPatch is caretakerFor for a PATCH (patch.go's tri-state): the
// handler reads caretakerId with patchField like any other field, then
// hands the pair here. Not set leaves the column alone. Set with a value
// resolves it as caretakerFor does. Set as null cannot reach here — the
// spec marks the field not nullable and validation refuses it first — but
// is treated as "leave alone" rather than trusted, since a NULL caretaker
// is a row nobody did.
func caretakerPatch(ctx context.Context, d Deps, fam middleware.FamilyCtx, set bool, val *string) (bool, *string, bool, error) {
	if !set || val == nil {
		return false, nil, false, nil
	}
	id, notMember, err := caretakerFor(ctx, d, fam, val)
	if err != nil || notMember {
		return false, nil, notMember, err
	}
	return true, &id, false, nil
}

// notMemberErr is the 403 a write naming a stranger as caretaker gets —
// the same message and code the kiosk middleware uses for its header.
func notMemberErr() gen.Error {
	return gen.Error{Error: "Not a member of this family", Code: "NOT_MEMBER"}
}
