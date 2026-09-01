package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/auth"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/babies.ts (REF §A1's babies.ts route
// table) plus the family/member-management endpoints REF §A1 lists as "NEW
// in Go" at the end of admin.ts — everything except /api/me (me.go) and the
// admin/impersonation surface (Task 21, not this one).
//
// Every method below is reached only through the tierFamily/tierAdmin chain
// api.go's authChain wires per operationAuthTiers, so
// middleware.FamilyFromContext(ctx) is always populated and, for the
// tierAdmin operations (DeleteBaby, DeleteFamilyMember,
// SetFamilyMemberRole), the caller is already known to be a family admin —
// unlike apps/api/src/routes/babies.ts, which checked the role by hand
// inside deleteBaby because Hono had no equivalent middleware wired at that
// granularity. middleware.RequireAdmin's rejection envelope
// ({"error":"Admin only","code":"FORBIDDEN"}) is byte-for-byte what the
// TypeScript handler wrote by hand, so callers see no difference.
//
// CreateBaby and UpdateBaby both take a required request body that the
// generated Go type still spells as a nilable pointer; both guard it the
// same way, via errNoRequestBody — see its doc comment for why that's a
// plain (500) error rather than a typed 4xx response, and how it differs
// from UpdateBaby's genuinely-empty-body no-op.

// notFound is the {"error":"Not found","code":"NOT_FOUND"} envelope every
// 404 below uses except GetFamily, whose TypeScript predecessor used a
// different message ("Family not found" — see GetFamily).
func notFound() gen.Error {
	return gen.Error{Error: "Not found", Code: "NOT_FOUND"}
}

func serBaby(b dbgen.Baby) gen.Baby {
	return gen.Baby{
		Id:        b.ID,
		Name:      b.Name,
		BirthDate: b.BirthDate.Time,
		Sex:       babySexPtr(b.Sex),
	}
}

func babySexPtr(s *string) *gen.BabySex {
	if s == nil {
		return nil
	}
	v := gen.BabySex(*s)
	return &v
}

// ListBabies implements GET /api/babies. REF: "Baby[] {id, name, birthDate,
// sex}", ordered oldest-first (ListBabies' own ORDER BY created_at).
func (d Deps) ListBabies(ctx context.Context, _ gen.ListBabiesRequestObject) (gen.ListBabiesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListBabies(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.Baby, len(rows))
	for i, row := range rows {
		out[i] = serBaby(row)
	}
	return gen.ListBabies200JSONResponse(out), nil
}

// errNoRequestBody is the one convention this package uses for an
// impossible-in-practice nil request body: every operation with a required
// requestBody (CreateBaby, UpdateBaby, and every future POST/PATCH route
// that follows this pattern) can, per the generated Go types, be called
// with req.Body == nil — but spec (request-shape) validation, wired as
// NewHandler's outer Middlewares layer ahead of the strict handler's own
// body decode, already rejects a request with no body before any
// gen.StrictServerInterface method runs. Reaching this is therefore a
// wiring bug in that validation layer, not a real, reachable client error:
// a plain error (routed through responseErrorHandler to the standard 500
// INTERNAL envelope, logged server-side) rather than a typed 4xx response,
// and the SAME shape everywhere rather than each handler inventing its own.
//
// This is distinct from — and must not be confused with — a genuinely
// empty JSON object body ({}), which decodes to a non-nil Body pointing at
// an all-nil-fields struct; see UpdateBaby for how that (real, tested,
// meaningful) case is handled.
func errNoRequestBody(operation string) error {
	return fmt.Errorf("api: %s reached with no request body", operation)
}

// CreateBaby implements POST /api/babies. REF: free in Go — the
// multipleBabies 402 gate apps/api/src/routes/babies.ts applied is removed
// (CLAUDE.md's entitlement helper always returns true today; Task 9's route
// table says so explicitly).
func (d Deps) CreateBaby(ctx context.Context, req gen.CreateBabyRequestObject) (gen.CreateBabyResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateBaby")
	}
	body := req.Body

	var sex *string
	if body.Sex != nil {
		v := string(*body.Sex)
		sex = &v
	}

	baby, err := d.Q.CreateBaby(ctx, dbgen.CreateBabyParams{
		FamilyID:  fam.FamilyID,
		Name:      body.Name,
		BirthDate: pgtype.Timestamptz{Time: body.BirthDate, Valid: true},
		Sex:       sex,
	})
	if err != nil {
		return nil, err
	}
	return gen.CreateBaby201JSONResponse(serBaby(baby)), nil
}

// UpdateBaby implements PATCH /api/babies/{id}. REF: "{name?, birthDate?,
// sex?} → Baby / 404". A genuinely empty JSON object body ({}, which
// decodes to a non-nil Body whose three fields are all nil) is a no-op
// that re-reads the row unchanged, mirroring apps/api/src/db/scoped.ts's
// updateBaby (compactPatch on an empty patch skips the UPDATE entirely
// rather than running one with no SET clause). This is NOT the same
// condition as req.Body itself being nil — see errNoRequestBody.
//
// sex is nullable+optional in the OpenAPI schema, but a plain Go pointer
// (what oapi-codegen generates for it) cannot distinguish "the field was
// omitted" from "the field was sent as null" — both decode to a nil
// pointer. Both are therefore treated as "leave sex unchanged": only a
// non-nil Sex (an actual "girl"/"boy" value) updates the column. This means
// there is currently no way to clear a baby's sex back to unknown through
// this endpoint — untested and unneeded today (see the UpdateBaby schema's
// description in openapi/pjokk.yaml) — as opposed to name/birthDate, which
// are optional-but-not-nullable and have no such ambiguity.
func (d Deps) UpdateBaby(ctx context.Context, req gen.UpdateBabyRequestObject) (gen.UpdateBabyResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	existing, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateBaby404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	if req.Body == nil {
		return nil, errNoRequestBody("UpdateBaby")
	}
	body := req.Body
	if body.Name == nil && body.BirthDate == nil && body.Sex == nil {
		return gen.UpdateBaby200JSONResponse(serBaby(existing)), nil
	}

	name := existing.Name
	if body.Name != nil {
		name = *body.Name
	}
	birthDate := existing.BirthDate
	if body.BirthDate != nil {
		birthDate = pgtype.Timestamptz{Time: *body.BirthDate, Valid: true}
	}
	sex := existing.Sex
	if body.Sex != nil {
		v := string(*body.Sex)
		sex = &v
	}

	updated, err := d.Q.UpdateBaby(ctx, dbgen.UpdateBabyParams{
		FamilyID:  fam.FamilyID,
		ID:        req.Id,
		Name:      name,
		BirthDate: birthDate,
		Sex:       sex,
	})
	if err != nil {
		return nil, err
	}
	return gen.UpdateBaby200JSONResponse(serBaby(updated)), nil
}

// DeleteBaby implements DELETE /api/babies/{id}. REF: "{ok:true}; 403 unless
// memberRole admin/owner; cascades logs" — the role check is
// middleware.RequireAdmin (tierAdmin), not this method; the cascade is the
// baby table's own FKs (ON DELETE CASCADE on every log table), not
// application code.
func (d Deps) DeleteBaby(ctx context.Context, req gen.DeleteBabyRequestObject) (gen.DeleteBabyResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteBaby(ctx, dbgen.DeleteBabyParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteBaby404JSONResponse(notFound()), nil
	}
	return gen.DeleteBaby200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// GetFamily implements GET /api/family. REF: "{id, name, slug, plan} / 404".
// The 404 is effectively unreachable in practice — middleware.RequireFamily
// already proved a live membership row (and therefore a live organization
// row) exists before this method runs — but is kept, with the exact message
// apps/api/src/routes/babies.ts used, as a defensive match to the TS
// behaviour rather than an assumption this method leans on.
func (d Deps) GetFamily(ctx context.Context, _ gen.GetFamilyRequestObject) (gen.GetFamilyResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	row, err := d.Q.GetFamilyBySlugless(ctx, fam.FamilyID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.GetFamily404JSONResponse{Error: "Family not found", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}
	return gen.GetFamily200JSONResponse{Id: row.ID, Name: row.Name, Slug: row.Slug, Plan: row.Plan}, nil
}

// ListFamilyMembers implements GET /api/family/members. REF: "Member[]
// {memberId, userId, name, email, role, image}".
func (d Deps) ListFamilyMembers(ctx context.Context, _ gen.ListFamilyMembersRequestObject) (gen.ListFamilyMembersResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListFamilyMembers(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.Member, len(rows))
	for i, row := range rows {
		out[i] = gen.Member{
			MemberId: row.MemberID,
			UserId:   row.UserID,
			Name:     row.Name,
			Email:    row.Email,
			Role:     row.Role,
			Image:    row.Image,
		}
	}
	return gen.ListFamilyMembers200JSONResponse(out), nil
}

// DeleteFamilyMember implements DELETE /api/family/members/{memberId}. NEW
// in Go (REF §A1, end of admin.ts): "{ok:true}; requireAdmin; 404". Thin
// wrapper over auth.Service.RemoveMember, which already does the
// membership-row lookup, session-detach and role-row/membership-row
// deletes in one transaction (see internal/auth/auth.go's doc comment on
// why it doesn't use Limen's actor-checked RemoveMember directly).
func (d Deps) DeleteFamilyMember(ctx context.Context, req gen.DeleteFamilyMemberRequestObject) (gen.DeleteFamilyMemberResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if err := d.Auth.RemoveMember(ctx, fam.FamilyID, req.MemberId); err != nil {
		if errors.Is(err, auth.ErrMemberNotInFamily) {
			return gen.DeleteFamilyMember404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	return gen.DeleteFamilyMember200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// SetFamilyMemberRole implements POST /api/family/members/{memberId}/role.
// NEW in Go (REF §A1, end of admin.ts): "{role: admin|member} → {ok:true};
// requireAdmin; 404". The role's admin|member shape is already enforced by
// spec validation before this method runs; auth.Service.SetMemberRole
// re-validates it too (validRole), which is fine — defense in depth, not a
// second source of truth.
func (d Deps) SetFamilyMemberRole(ctx context.Context, req gen.SetFamilyMemberRoleRequestObject) (gen.SetFamilyMemberRoleResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	role := string(req.Body.Role)
	if err := d.Auth.SetMemberRole(ctx, fam.FamilyID, req.MemberId, role); err != nil {
		if errors.Is(err, auth.ErrMemberNotInFamily) {
			return gen.SetFamilyMemberRole404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	return gen.SetFamilyMemberRole200JSONResponse{Ok: gen.OkOkTrue}, nil
}
