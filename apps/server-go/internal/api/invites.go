package api

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/invites.ts (REF §A1's invites.ts route
// table): the family-admin management surface (GET/POST /api/invites,
// DELETE /api/invites/{code}, all tierAdmin) plus the public surface
// (GET /api/invites/info/{code}, tierPublic; POST /api/invites/redeem,
// tierSession — see api.go's operationAuthTiers and its doc comment for
// what those tiers mean). Codes are credentials — apps/api/src/app.ts
// mounted the public two behind Hono rate-limit middleware; this port
// wires the same four limits (30/500 for info, 10/200 for redeem) via
// api.go's rateLimitChain instead, since a per-operation StrictMiddlewareFunc
// is this codebase's equivalent of createRoute's `middleware:` array.
//
// # Redeem: why the membership insert is hand-written SQL, not auth.Service
//
// The TypeScript predecessor's redeem is a single db.transaction(): lock the
// row (SELECT … FOR UPDATE), re-classify it, re-check membership, insert the
// membership row, bump used_count — one atomic unit. auth.Service.AddMember
// (internal/auth/auth.go) exists for this, but it goes through Limen's
// organization plugin, which opens ITS OWN transaction — nesting that inside
// this one would mean two independent commit points, defeating the entire
// point of locking the invite row first. Instead redeemInviteTx writes
// exactly the two rows Limen's insertMemberWithRole would (read off
// github.com/thecodearcher/limen/plugins/organization's members.go): an
// organization_members row (organization_id, user_id — id/created_at/
// updated_at all default) via queries/invites.sql's InsertOrganizationMember,
// then an organization_member_roles row via auth.sql's
// InsertFamilyMemberRole (the exact INSERT assignMemberRole issues) — both
// through the SAME *dbgen.Queries bound to this function's own transaction.

// inviteCodeAlphabet mirrors apps/api/src/db/scoped.ts's CODE_ALPHABET
// exactly: unambiguous when read aloud across a dinner table (no 0/O, no
// 1/I, and no L either — the TS alphabet omits it too). Do not "complete"
// this to a full 26 letters; a divergence here would make one port's codes
// valid input the other's generator could never produce, which is harmless
// on its own but a sign the two have drifted.
const inviteCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// inviteCodeLength matches generateInviteCode's default length=8 in the
// TypeScript predecessor.
const inviteCodeLength = 8

// generateInviteCode returns a fresh 8-character code from
// inviteCodeAlphabet, crypto/rand-backed like apps/api/src/db/scoped.ts's
// generateInviteCode (Web Crypto there, crypto/rand here — same source of
// randomness, different API).
func generateInviteCode() (string, error) {
	buf := make([]byte, inviteCodeLength)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("api: generate invite code: %w", err)
	}
	code := make([]byte, inviteCodeLength)
	for i, b := range buf {
		code[i] = inviteCodeAlphabet[int(b)%len(inviteCodeAlphabet)]
	}
	return string(code), nil
}

func serInvite(row dbgen.FamilyInvite, appURL string) gen.Invite {
	return gen.Invite{
		Code:      row.Code,
		FamilyId:  row.FamilyID,
		Role:      gen.InviteRole(row.Role),
		ExpiresAt: row.ExpiresAt.Time,
		MaxUses:   int(row.MaxUses),
		UsedCount: int(row.UsedCount),
		RevokedAt: tsPtr(row.RevokedAt),
		Url:       fmt.Sprintf("%s/join/%s", appURL, row.Code),
	}
}

// inviteClassification mirrors apps/api/src/routes/invites.ts's
// classifyInvite: the empty string means valid (TS's `null`), any other
// value is the reason it isn't — used verbatim as InviteInfo.reason and as
// the substring of RedeemInvite400JSONResponse's message.
type inviteClassification string

const (
	inviteValid     inviteClassification = ""
	inviteRevoked   inviteClassification = "revoked"
	inviteExpired   inviteClassification = "expired"
	inviteExhausted inviteClassification = "exhausted"
	inviteNotFound  inviteClassification = "not_found"
)

// classifyInvite reports why row cannot be redeemed right now, or
// inviteValid if it can. row == nil means "no such code" (the TS
// predecessor's classifyInvite(undefined, …) → "not_found").
func classifyInvite(row *dbgen.FamilyInvite, now time.Time) inviteClassification {
	switch {
	case row == nil:
		return inviteNotFound
	case row.RevokedAt.Valid:
		return inviteRevoked
	case !row.ExpiresAt.Time.After(now):
		return inviteExpired
	case row.UsedCount >= row.MaxUses:
		return inviteExhausted
	default:
		return inviteValid
	}
}

// ListInvites implements GET /api/invites. REF: "every code ever issued for
// the family, newest first — used and revoked ones included". Family admin
// only (api.go's tierAdmin entry).
func (d Deps) ListInvites(ctx context.Context, _ gen.ListInvitesRequestObject) (gen.ListInvitesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListInvites(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.Invite, len(rows))
	for i, row := range rows {
		out[i] = serInvite(row, d.AppURL)
	}
	return gen.ListInvites200JSONResponse(out), nil
}

// CreateInvite implements POST /api/invites. REF: "optional body
// {role(admin|member, default member), expiresInHours(1..720, default 72),
// maxUses(1..50, default 5)} → 201 Invite". Family admin only. The body
// itself is optional (spec: requestBody.required=false, matching
// CreateInviteSchema's all-defaulted Zod shape) — a nil req.Body, and a nil
// field within a present body, both mean "use the default", exactly like
// apps/api/src/routes/invites.ts's `c.req.valid("json") ?? {…defaults}`.
func (d Deps) CreateInvite(ctx context.Context, req gen.CreateInviteRequestObject) (gen.CreateInviteResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	role := string(gen.CreateInviteRoleMember)
	expiresInHours := 72
	maxUses := 5
	if req.Body != nil {
		if req.Body.Role != nil {
			role = string(*req.Body.Role)
		}
		if req.Body.ExpiresInHours != nil {
			expiresInHours = *req.Body.ExpiresInHours
		}
		if req.Body.MaxUses != nil {
			maxUses = *req.Body.MaxUses
		}
	}

	code, err := generateInviteCode()
	if err != nil {
		return nil, err
	}

	row, err := d.Q.CreateInvite(ctx, dbgen.CreateInviteParams{
		Code:      code,
		FamilyID:  fam.FamilyID,
		Role:      role,
		ExpiresAt: pgtype.Timestamptz{Time: d.Now().Add(time.Duration(expiresInHours) * time.Hour), Valid: true},
		MaxUses:   int32(maxUses),
		CreatedBy: fam.UserID,
	})
	if err != nil {
		return nil, err
	}
	return gen.CreateInvite201JSONResponse(serInvite(row, d.AppURL)), nil
}

// RevokeInvite implements DELETE /api/invites/{code}. REF: "{ok:true} /
// 404". Family admin only. Unlike GetInviteInfo/RedeemInvite, the code
// path param is used exactly as given — no uppercasing — matching
// apps/api/src/db/scoped.ts's revokeInvite, which never normalises it
// either (an admin revokes the code exactly as ListInvites displayed it,
// already uppercase).
func (d Deps) RevokeInvite(ctx context.Context, req gen.RevokeInviteRequestObject) (gen.RevokeInviteResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.RevokeInvite(ctx, dbgen.RevokeInviteParams{
		Code:      req.Code,
		FamilyID:  fam.FamilyID,
		RevokedAt: pgtype.Timestamptz{Time: d.Now(), Valid: true},
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.RevokeInvite404JSONResponse(notFound()), nil
	}
	return gen.RevokeInvite200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// getInviteByCodeOrNil is GetInviteByCode with pgx.ErrNoRows folded into a
// nil result, the shape classifyInvite and every caller below want (rather
// than every call site repeating the errors.Is check).
func (d Deps) getInviteByCodeOrNil(ctx context.Context, code string) (*dbgen.FamilyInvite, error) {
	row, err := d.Q.GetInviteByCode(ctx, code)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, err
	default:
		return &row, nil
	}
}

// GetInviteInfo implements GET /api/invites/info/{code}. REF: "what the
// /join page shows before sign-in: which family, which role, still valid?"
// — tierPublic (api.go), no session required. Codes are generated
// uppercase to be read aloud; accepted typed in any case (REF §A1's
// case-insensitivity note; apps/api/src/routes/invites.ts's inviteInfo
// handler does the identical `.toUpperCase()`).
func (d Deps) GetInviteInfo(ctx context.Context, req gen.GetInviteInfoRequestObject) (gen.GetInviteInfoResponseObject, error) {
	code := strings.ToUpper(req.Code)
	invite, err := d.getInviteByCodeOrNil(ctx, code)
	if err != nil {
		return nil, err
	}

	reason := classifyInvite(invite, d.Now())
	if invite == nil || reason != inviteValid {
		r := gen.InviteInfoReason(reason)
		return gen.GetInviteInfo200JSONResponse{
			Valid:      false,
			FamilyName: nil,
			Role:       nil,
			Reason:     &r,
		}, nil
	}

	var familyName *string
	org, err := d.Q.GetFamilyBySlugless(ctx, invite.FamilyID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// familyName stays nil — matches org[0]?.name ?? null.
	case err != nil:
		return nil, err
	default:
		name := org.Name
		familyName = &name
	}

	role := gen.InviteInfoRole(invite.Role)
	return gen.GetInviteInfo200JSONResponse{
		Valid:      true,
		FamilyName: familyName,
		Role:       &role,
		Reason:     nil,
	}, nil
}

// RedeemInvite implements POST /api/invites/redeem. REF: "{code(1..64)} →
// 200 RedeemResult / 400 invalid / 401 not signed in". tierSession
// (api.go) already guarantees a session by the time this runs — see
// GetMe's identical guard for why the nil check below is defensive rather
// than a real, reachable 401 path (RequireSession already answered that
// one, with the SAME body this file would otherwise have to reconstruct
// by hand).
func (d Deps) RedeemInvite(ctx context.Context, req gen.RedeemInviteRequestObject) (gen.RedeemInviteResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return nil, fmt.Errorf("api: RedeemInvite reached with no session (RequireSession not wired?)")
	}
	if req.Body == nil {
		return nil, errNoRequestBody("RedeemInvite")
	}

	code := strings.ToUpper(req.Body.Code)
	userID := session.UserID
	now := d.Now()

	invite, err := d.getInviteByCodeOrNil(ctx, code)
	if err != nil {
		return nil, err
	}
	reason := classifyInvite(invite, now)
	if invite == nil || reason != inviteValid {
		return gen.RedeemInvite400JSONResponse{
			Error: fmt.Sprintf("Invite %s", reason),
			Code:  "INVALID_INVITE",
		}, nil
	}

	familyName := "family"
	if org, err := d.Q.GetFamilyBySlugless(ctx, invite.FamilyID); err == nil {
		if org.Name != "" {
			familyName = org.Name
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	already, err := d.Q.CountFamilyMembership(ctx, dbgen.CountFamilyMembershipParams{
		OrganizationID: invite.FamilyID,
		UserID:         userID,
	})
	if err != nil {
		return nil, err
	}
	if already > 0 {
		d.setActiveFamilyBestEffort(ctx, session.Token, invite.FamilyID)
		return gen.RedeemInvite200JSONResponse{
			FamilyId:      invite.FamilyID,
			FamilyName:    familyName,
			Role:          gen.RedeemResultRole(invite.Role),
			AlreadyMember: true,
		}, nil
	}

	redeemed, err := d.redeemInviteTx(ctx, code, userID)
	if err != nil {
		return nil, err
	}
	if !redeemed {
		return gen.RedeemInvite400JSONResponse{
			Error: "Invite no longer valid",
			Code:  "INVALID_INVITE",
		}, nil
	}

	d.setActiveFamilyBestEffort(ctx, session.Token, invite.FamilyID)
	return gen.RedeemInvite200JSONResponse{
		FamilyId:      invite.FamilyID,
		FamilyName:    familyName,
		Role:          gen.RedeemResultRole(invite.Role),
		AlreadyMember: false,
	}, nil
}

// redeemInviteTx is the atomic core of RedeemInvite: lock the row, re-check
// everything the optimistic read above already checked (a concurrent
// redeem may have exhausted, revoked, or otherwise changed it since), then
// write the membership + role rows and bump used_count — all inside one
// transaction, or none of it. Reports false for every "cannot redeem"
// outcome (row vanished under the lock, no-longer-valid, or a race that
// added the membership between the two reads) without distinguishing which
// — same as the TypeScript predecessor's `return false` from inside
// db.transaction(), which the caller turns into a single "Invite no longer
// valid" response regardless of which guard tripped.
//
// See this file's package doc comment for why the membership rows are
// written here directly rather than through auth.Service.AddMember.
//
// The re-classification below deliberately calls d.Now() itself rather
// than reusing the caller's pre-lock timestamp: a redeem that blocks
// waiting for GetInviteByCodeForUpdate's lock (another concurrent redeem
// of the SAME code holding it) could otherwise accept a code that expired
// during the wait, evaluating "expired" against a clock reading from
// before the wait even started. The TypeScript predecessor has the
// identical property — its in-transaction classifyInvite call reads
// Date.now() fresh, not the outer handler's captured `now`.
func (d Deps) redeemInviteTx(ctx context.Context, code, userID string) (bool, error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	locked, err := qtx.GetInviteByCodeForUpdate(ctx, code)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	if classifyInvite(&locked, d.Now()) != inviteValid {
		return false, nil
	}

	already, err := qtx.CountFamilyMembership(ctx, dbgen.CountFamilyMembershipParams{
		OrganizationID: locked.FamilyID,
		UserID:         userID,
	})
	if err != nil {
		return false, err
	}
	if already > 0 {
		return false, nil
	}

	// A second membership race this pre-check cannot close: the FOR
	// UPDATE lock above only serializes redeems of THIS code, so the same
	// user redeeming a DIFFERENT code for the SAME family concurrently
	// can pass both codes' membership pre-checks before either INSERT
	// runs, then collide on idx_organization_members_org_user
	// (00002_limen_align.sql) below. Folded into the same "cannot
	// redeem" false, rather than surfacing db.IsUniqueViolation as a raw
	// 500 — the caller already returns the identical 400 for the
	// ordinary already>0 race just above; an alreadyMember:true response
	// would be equally defensible here (the user ends up a member either
	// way), but building one needs familyName/role this function has no
	// reason to carry, so the simpler, already-consistent "false" wins.
	memberID, err := qtx.InsertOrganizationMember(ctx, dbgen.InsertOrganizationMemberParams{
		OrganizationID: locked.FamilyID,
		UserID:         userID,
	})
	if err != nil {
		if db.IsUniqueViolation(err) {
			return false, nil
		}
		return false, err
	}

	role := locked.Role
	if err := qtx.InsertFamilyMemberRole(ctx, dbgen.InsertFamilyMemberRoleParams{
		MemberID:       memberID,
		OrganizationID: locked.FamilyID,
		Role:           &role,
	}); err != nil {
		return false, err
	}

	if err := qtx.IncrementInviteUsedCount(ctx, code); err != nil {
		return false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// setActiveFamilyBestEffort mirrors apps/api/src/routes/invites.ts's
// setActive helper: non-fatal by design (the client also calls
// setActiveOrganization after landing), so a failure here must not turn an
// otherwise-successful redeem into an error response.
func (d Deps) setActiveFamilyBestEffort(ctx context.Context, sessionToken, familyID string) {
	_ = d.Auth.SetActiveFamily(ctx, sessionToken, familyID)
}
