package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
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

	me := gen.Me{
		UserId: session.UserID,
		Name:   session.Name,
		Email:  session.Email,
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
			// A stale active_organization_id — the membership row is
			// gone, same situation middleware.RequireFamily guards every
			// other route against. GetMe just reports "no family" rather
			// than rejecting the caller, per its whole purpose: it never
			// refuses a session.
		case err != nil:
			return nil, err
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

	return gen.GetMe200JSONResponse(me), nil
}
