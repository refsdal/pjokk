package api

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/auth"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// GetMe implements GET /api/me — NEW in Go (REF §A1, end of admin.ts):
// "session info for the SPA shell, replaces scattered better-auth session
// casts". Session required, family NOT required: familyId/memberRole/plan
// are null for a caller with no active family, and this method never
// refuses one — that IS the point of the route (every OTHER /api/ route
// needs RequireFamily; this is the one the SPA shell calls to find out
// whether it should even try).
//
// Reached only through tierSession (api.go's authChain), whose chain ends
// in middleware.RequireSession — the one middleware in this whole surface
// that stops an anonymous caller WITHOUT also requiring a family — so
// middleware.SessionFromContext(ctx) is guaranteed non-nil here.
func (d Deps) GetMe(ctx context.Context, _ gen.GetMeRequestObject) (gen.GetMeResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		// RequireSession guarantees this already; fail loudly rather than
		// silently serving a zero-value session if that wiring is ever
		// broken.
		return nil, fmt.Errorf("api: GetMe reached with no session (RequireSession not wired?)")
	}
	// Once per account: copy Google's picture into our store (no-op unless
	// this is the first /api/me after a Google sign-in — see avatar_import.go).
	d.importGoogleAvatar(ctx, session.UserID)

	me, err := d.buildMe(ctx, session)
	if err != nil {
		return nil, err
	}
	return gen.GetMe200JSONResponse(me), nil
}

// phonePattern is the whole of what a phone field may hold: digits, spaces
// and the punctuation people actually type. Anything else is a 400 rather
// than something stored and shown back later.
var phonePattern = regexp.MustCompile(`^[0-9 +()\-]+$`)

// UpdateMe implements PATCH /api/me. Session tier, no family: a profile is
// global. Uses the raw-body tri-state (patch.go) so `null` clears nickname
// or phone while an absent key leaves the column alone — the same
// convention every log PATCH follows.
func (d Deps) UpdateMe(ctx context.Context, _ gen.UpdateMeRequestObject) (gen.UpdateMeResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return nil, fmt.Errorf("api: UpdateMe reached with no session (RequireSession not wired?)")
	}

	p, err := patchBody(ctx, "UpdateMe")
	if err != nil {
		return nil, err
	}
	nameSet, nameVal := patchField[string](p, "name")
	nickSet, nickVal := patchField[string](p, "nickname")
	phoneSet, phoneVal := patchField[string](p, "phone")
	unitsSet, unitsVal := patchField[string](p, "units")
	if err := p.Err(); err != nil {
		return nil, err
	}

	current, err := d.Q.GetUserProfile(ctx, session.UserID)
	if err != nil {
		return nil, err
	}

	name := current.Name
	if nameSet {
		// The spec marks name non-nullable, so validation already refused
		// a literal null; guard anyway rather than dereference nil.
		if nameVal == nil || strings.TrimSpace(*nameVal) == "" {
			return gen.UpdateMe400JSONResponse(gen.Error{Error: "Name cannot be blank", Code: "VALIDATION"}), nil
		}
		name = strings.TrimSpace(*nameVal)
	}
	nickname := current.Nickname
	if nickSet {
		nickname = trimmedOrNil(nickVal)
	}
	phone := current.Phone
	if phoneSet {
		phone = trimmedOrNil(phoneVal)
		if phone != nil && !phonePattern.MatchString(*phone) {
			return gen.UpdateMe400JSONResponse(gen.Error{Error: "Phone may only hold digits, spaces, +, -, ( and )", Code: "VALIDATION"}), nil
		}
	}

	units := current.Units
	if unitsSet {
		// The spec's enum already refused anything but the two values and
		// null; guard the nil anyway.
		if unitsVal == nil {
			return gen.UpdateMe400JSONResponse(gen.Error{Error: "Units must be metric or imperial", Code: "VALIDATION"}), nil
		}
		units = *unitsVal
	}

	if err := d.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID:       session.UserID,
		Name:     &name,
		Nickname: nickname,
		Phone:    phone,
		Units:    units,
	}); err != nil {
		return nil, err
	}

	me, err := d.buildMe(ctx, session)
	if err != nil {
		return nil, err
	}
	return gen.UpdateMe200JSONResponse(me), nil
}

// trimmedOrNil turns a PATCH value into what the column stores: nil for
// null, nil for whitespace-only, otherwise the trimmed string.
func trimmedOrNil(v *string) *string {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if s == "" {
		return nil
	}
	return &s
}

// avatarURL is the one place the avatar URL shape lives. The version is the
// key's file name (a fresh uuid per upload), so a re-upload is a new URL and
// no <img> ever shows a stale photo from the browser cache.
func avatarURL(userID string, key *string) *string {
	if key == nil || *key == "" {
		return nil
	}
	u := "/api/users/" + userID + "/avatar?v=" + path.Base(*key)
	return &u
}

// buildMe assembles the Me payload from the session and a fresh read of the
// profile row. Shared by GET and PATCH: after a write the row, not the
// session snapshot taken at the start of the request, is the truth.
func (d Deps) buildMe(ctx context.Context, session *auth.Session) (gen.Me, error) {
	profile, err := d.Q.GetUserProfile(ctx, session.UserID)
	if err != nil {
		return gen.Me{}, err
	}

	me := gen.Me{
		UserId:      session.UserID,
		Name:        profile.Name,
		DisplayName: profile.DisplayName,
		Nickname:    profile.Nickname,
		Phone:       profile.Phone,
		AvatarUrl:   avatarURL(session.UserID, profile.AvatarKey),
		Email:       session.Email,
		Version:     d.Version,
		Units:       gen.MeUnits(profile.Units),
	}
	if session.Role != "" {
		role := session.Role
		me.Role = &role
	}
	if session.ImpersonatedBy != "" {
		impersonatedBy := session.ImpersonatedBy
		me.ImpersonatedBy = &impersonatedBy
	}

	if session.ActiveFamilyID != "" {
		familyID := session.ActiveFamilyID
		row, err := d.Q.GetFamilyMembershipRole(ctx, dbgen.GetFamilyMembershipRoleParams{
			OrganizationID: familyID,
			UserID:         session.UserID,
		})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Stale active_organization_id — report "no family", never refuse.
		case err != nil:
			return gen.Me{}, err
		default:
			me.FamilyId = &familyID
			plan := row.Plan
			me.Plan = &plan
			if row.Role != "" {
				role := row.Role
				me.MemberRole = &role
			}
		}
	}
	return me, nil
}
