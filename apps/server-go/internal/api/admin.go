package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/admin.ts (REF §A1's admin.ts route
// table) AND the surface the TypeScript app got from better-auth's admin
// plugin over /api/auth/admin/* — REF §A1's "NEW in Go" table: listing
// users, banning, unbanning, setting a password, revoking sessions and
// impersonation. Limen has no admin plugin, so those are ours now; the
// session machinery they need already exists on auth.Service (Task 4).
//
// Everything here runs behind tierSysadmin (api.go's operationAuthTiers),
// with the single, deliberate exception of StopImpersonating — see its own
// doc comment and the tier map's.
//
// # Billing is gone
//
// The TypeScript predecessor's POST /api/admin/families/{id}/plan (the
// audited free↔comp override) and the Stripe subscription cancellation
// inside deleteFamily are both absent by design: this port has no billing
// (REF §A1: "Stripe cancel/subscription rows GONE in Go"). Deleting a
// family is now nothing but an audited DELETE that the schema cascades.
//
// # Auditing
//
// Every mutation writes an admin_audit row through middleware.Audit before
// the change lands, so a failure leaves a record of the attempt rather than
// a silent gap. The admin_id is always the REAL operator: for the
// impersonation pair that means the system admin, never the account being
// impersonated (StopImpersonating reads it from the session's
// impersonated_by marker, which only the server writes).

// refused is the 400 envelope apps/api/src/routes/admin.ts used for
// "this account may not be deleted" (self, or the tombstone). The same code
// covers the guards this port adds — self-ban and impersonating
// yourself/a banned account — with a message that says which.
func refused(message string) gen.Error {
	return gen.Error{Error: message, Code: "REFUSED"}
}

// adminID is the operator behind a tierSysadmin request. RequireSysadmin
// guarantees a session, so a missing one is a wiring bug and reported as
// one rather than silently attributing an audit row to "".
func adminID(ctx context.Context) (string, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return "", errors.New("api: admin route reached with no session (RequireSysadmin not wired?)")
	}
	return session.UserID, nil
}

// GetAdminStats implements GET /api/admin/stats.
func (d Deps) GetAdminStats(ctx context.Context, _ gen.GetAdminStatsRequestObject) (gen.GetAdminStatsResponseObject, error) {
	weekAgo := pgtype.Timestamptz{Time: d.Now().Add(-7 * 24 * time.Hour), Valid: true}
	row, err := d.Q.GetAdminStats(ctx, weekAgo)
	if err != nil {
		return nil, err
	}
	return gen.GetAdminStats200JSONResponse{
		Families:          int(row.Families),
		Users:             int(row.Users),
		Babies:            int(row.Babies),
		CoreLogs:          int(row.CoreLogs),
		PushSubscriptions: int(row.PushSubscriptions),
		UsersLast7d:       int(row.UsersLast7d),
	}, nil
}

// ListAdminFamilies implements GET /api/admin/families.
func (d Deps) ListAdminFamilies(ctx context.Context, _ gen.ListAdminFamiliesRequestObject) (gen.ListAdminFamiliesResponseObject, error) {
	rows, err := d.Q.ListAdminFamilies(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]gen.AdminFamily, len(rows))
	for i, row := range rows {
		out[i] = gen.AdminFamily{
			Id:         row.ID,
			Name:       row.Name,
			Slug:       row.Slug,
			Plan:       row.Plan,
			CreatedAt:  row.CreatedAt.Time,
			Members:    int(row.Members),
			Babies:     int(row.Babies),
			LastFeedAt: tsPtr(row.LastFeedAt),
		}
	}
	return gen.ListAdminFamilies200JSONResponse(out), nil
}

// DeleteAdminFamily implements DELETE /api/admin/families/{id}: the family
// and every row the schema hangs off it. The audit row is written first and
// records the NAME as its detail — once the organization is gone, an id in
// the trail says nothing about what was destroyed.
func (d Deps) DeleteAdminFamily(ctx context.Context, req gen.DeleteAdminFamilyRequestObject) (gen.DeleteAdminFamilyResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	name, err := d.Q.GetOrganizationName(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.DeleteAdminFamily404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}

	middleware.Audit(ctx, d.Q, admin, "family.delete", req.Id, name)

	if _, err := d.Q.DeleteOrganization(ctx, req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteAdminFamily200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// adminUsersDefaultLimit is how many accounts GET /api/admin/users returns
// when the caller names no limit. The console's own list asks for the
// spec's maximum (200); this default only has to be enough to be useful
// for a hand-issued request.
const adminUsersDefaultLimit = 100

// ListAdminUsers implements GET /api/admin/users. NEW in Go (REF §A1's
// "NEW in Go" table): the TypeScript console called better-auth's
// admin.listUsers from the browser.
func (d Deps) ListAdminUsers(ctx context.Context, req gen.ListAdminUsersRequestObject) (gen.ListAdminUsersResponseObject, error) {
	limit := adminUsersDefaultLimit
	if req.Params.Limit != nil {
		limit = int(*req.Params.Limit)
	}

	rows, err := d.Q.ListAdminUsers(ctx, dbgen.ListAdminUsersParams{
		Query: req.Params.Query,
		Lim:   int32(limit),
	})
	if err != nil {
		return nil, err
	}

	out := make([]gen.AdminUser, len(rows))
	for i, row := range rows {
		out[i] = gen.AdminUser{
			Id:        row.ID,
			Name:      row.Name,
			Email:     row.Email,
			Role:      row.Role,
			Banned:    row.Banned,
			BanReason: row.BanReason,
			CreatedAt: row.CreatedAt.Time,
		}
	}
	return gen.ListAdminUsers200JSONResponse(out), nil
}

// DeleteAdminUser implements POST /api/admin/users/{id}/delete — the safe
// account deletion of apps/api/src/routes/admin.ts, in ONE transaction
// (D1 could not do that; Postgres can, per CLAUDE.md's "real transactions"
// note).
//
// Order matters. The reassignment runs before the audit insert so the
// victim's own admin_audit rows are tombstoned WITHOUT touching the
// user.delete row this call is about to write, whose admin is the operator.
// See queries/admin.sql's ReassignUserReferences for the full list of
// references and the three it covers that the TypeScript predecessor's
// did not.
func (d Deps) DeleteAdminUser(ctx context.Context, req gen.DeleteAdminUserRequestObject) (gen.DeleteAdminUserResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	if req.Id == admin || req.Id == db.TombstoneID {
		return gen.DeleteAdminUser400JSONResponse(refused("Refused")), nil
	}

	target, err := d.Q.GetAdminUser(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.DeleteAdminUser404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	if err := qtx.ReassignUserReferences(ctx, dbgen.ReassignUserReferencesParams{
		UserID:      req.Id,
		TombstoneID: db.TombstoneID,
		Now:         pgtype.Timestamptz{Time: d.Now(), Valid: true},
	}); err != nil {
		return nil, err
	}
	if err := qtx.DeleteCalendarAssigneesForUser(ctx, req.Id); err != nil {
		return nil, err
	}

	// Inside the transaction: an audit row for a delete that then rolls
	// back would be a lie. middleware.Audit is best-effort by design (it
	// swallows its error), which is right for the impersonated-write trail
	// but not here — this one insert is checked, so a trail failure aborts
	// the delete rather than losing the record of it.
	detail := target.Email
	if err := qtx.InsertAdminAudit(ctx, dbgen.InsertAdminAuditParams{
		AdminID: admin,
		Action:  "user.delete",
		Target:  req.Id,
		Detail:  &detail,
	}); err != nil {
		return nil, err
	}

	if _, err := qtx.DeleteAdminUser(ctx, req.Id); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return gen.DeleteAdminUser200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// BanAdminUser implements POST /api/admin/users/{id}/ban.
//
// The flag alone is not a revocation — auth.Service's own doc comment says
// so — hence the RevokeAllSessions call. The user's API keys stop working
// too, without anything here doing it: queries/middleware.sql's
// GetAPIKeyByHash joins on a non-banned creator (the hole Task 6 deferred
// to this task).
//
// Self-ban is refused. There is no unban endpoint reachable by a banned
// account, so an admin who banned themselves would have locked the whole
// console behind a database edit.
func (d Deps) BanAdminUser(ctx context.Context, req gen.BanAdminUserRequestObject) (gen.BanAdminUserResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Id == admin {
		return gen.BanAdminUser400JSONResponse(refused("Cannot ban your own account")), nil
	}

	target, err := d.Q.GetAdminUser(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.BanAdminUser404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}

	var reason *string
	if req.Body != nil {
		reason = req.Body.Reason
	}

	middleware.Audit(ctx, d.Q, admin, "user.ban", req.Id, target.Email)

	if err := d.Q.BanAdminUser(ctx, dbgen.BanAdminUserParams{ID: req.Id, BanReason: reason}); err != nil {
		return nil, err
	}
	if err := d.Auth.RevokeAllSessions(ctx, req.Id); err != nil {
		return nil, err
	}
	return gen.BanAdminUser200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// UnbanAdminUser implements POST /api/admin/users/{id}/unban. Sessions
// revoked by the ban stay revoked; the user signs in again.
func (d Deps) UnbanAdminUser(ctx context.Context, req gen.UnbanAdminUserRequestObject) (gen.UnbanAdminUserResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	target, err := d.Q.GetAdminUser(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.UnbanAdminUser404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}

	middleware.Audit(ctx, d.Q, admin, "user.unban", req.Id, target.Email)

	if err := d.Q.UnbanAdminUser(ctx, req.Id); err != nil {
		return nil, err
	}
	return gen.UnbanAdminUser200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// SetAdminUserPassword implements POST /api/admin/users/{id}/password.
//
// The audit row records the target and nothing else: a support tool that
// wrote the password it just set into an append-only table would be worse
// than the problem it solves.
func (d Deps) SetAdminUserPassword(ctx context.Context, req gen.SetAdminUserPasswordRequestObject) (gen.SetAdminUserPasswordResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("SetAdminUserPassword")
	}

	target, err := d.Q.GetAdminUser(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.SetAdminUserPassword404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}

	middleware.Audit(ctx, d.Q, admin, "user.password.set", req.Id, target.Email)

	if err := d.Auth.SetPassword(ctx, req.Id, req.Body.Password); err != nil {
		return nil, err
	}
	return gen.SetAdminUserPassword200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// RevokeAdminUserSessions implements POST
// /api/admin/users/{id}/sessions/revoke.
func (d Deps) RevokeAdminUserSessions(ctx context.Context, req gen.RevokeAdminUserSessionsRequestObject) (gen.RevokeAdminUserSessionsResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	target, err := d.Q.GetAdminUser(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.RevokeAdminUserSessions404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}

	middleware.Audit(ctx, d.Q, admin, "user.sessions.revoke", req.Id, target.Email)

	if err := d.Auth.RevokeAllSessions(ctx, req.Id); err != nil {
		return nil, err
	}
	return gen.RevokeAdminUserSessions200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// ImpersonateAdminUser implements POST /api/admin/users/{id}/impersonate.
//
// auth.Service.Impersonate needs the ResponseWriter (to swap the session
// cookie) and the Request (the new session records the caller's address and
// user agent) — neither of which the generated strict-server handler
// signature carries. middleware.CaptureHTTP, mounted on this tier, puts
// them back in the context; see its doc comment for why that is preferable
// to hand-routing two JSON endpoints outside the spec.
//
// The two guards below are this port's, not auth's: Impersonate refuses
// self-impersonation with a plain error (a 500 to the caller), and had no
// banned-target check at all (a gap Task 4's review deferred here). A
// banned account's sessions have just been revoked on purpose; minting a
// fresh one for it — which is exactly what impersonation does — would undo
// that.
func (d Deps) ImpersonateAdminUser(ctx context.Context, req gen.ImpersonateAdminUserRequestObject) (gen.ImpersonateAdminUserResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return nil, errors.New("api: ImpersonateAdminUser reached with no session (RequireSysadmin not wired?)")
	}
	if req.Id == session.UserID {
		return gen.ImpersonateAdminUser400JSONResponse(refused("Cannot impersonate yourself")), nil
	}

	target, err := d.Q.GetAdminUser(ctx, req.Id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.ImpersonateAdminUser404JSONResponse(notFound()), nil
	case err != nil:
		return nil, err
	}
	if target.Banned {
		return gen.ImpersonateAdminUser400JSONResponse(refused("Cannot impersonate a banned user")), nil
	}

	w, r, ok := middleware.HTTPFromContext(ctx)
	if !ok {
		return nil, errors.New("api: ImpersonateAdminUser reached without CaptureHTTP (tier wiring?)")
	}

	middleware.Audit(ctx, d.Q, session.UserID, "user.impersonate", req.Id, target.Email)

	if err := d.Auth.Impersonate(ctx, w, r, session, req.Id); err != nil {
		return nil, fmt.Errorf("api: impersonate %s: %w", req.Id, err)
	}
	return gen.ImpersonateAdminUser200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// StopImpersonating implements POST /api/admin/stop-impersonating: the exit
// from an impersonated session, restoring the operator's own cookie.
//
// It is tierSession rather than tierSysadmin, and that is load-bearing. The
// session making this request is the IMPERSONATED user's — an ordinary
// account, whose users.role is empty — so RequireSysadmin would answer 403
// and leave the operator with no way out but clearing their cookies. See
// api.go's operationAuthTiers for the same argument at the wiring site.
//
// The tier is looser; the authorization is not. Everything this handler
// acts on comes from the session's own impersonated_by marker, which is
// written server-side by Impersonate and can only be set by a system admin;
// a session without one gets 400 and nothing happens. The admin token used
// to restore the cookie is read from the server-only `impersonation` table
// inside auth (never from anything the caller supplies).
//
// auth.StopImpersonating is deliberately terminal on every failure — if the
// admin's session cannot be restored it revokes the impersonated one and
// clears the cookie anyway — so an error here means "you are signed out",
// not "nothing happened". That is reported as a plain 500; the audit row is
// already written, and the one outcome that must never occur (still holding
// a live session as the target) has been prevented either way.
func (d Deps) StopImpersonating(ctx context.Context, _ gen.StopImpersonatingRequestObject) (gen.StopImpersonatingResponseObject, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return nil, errors.New("api: StopImpersonating reached with no session (RequireSession not wired?)")
	}
	if session.ImpersonatedBy == "" {
		return gen.StopImpersonating400JSONResponse(gen.Error{
			Error: "This session is not impersonating anyone",
			Code:  "NOT_IMPERSONATING",
		}), nil
	}

	w, r, ok := middleware.HTTPFromContext(ctx)
	if !ok {
		return nil, errors.New("api: StopImpersonating reached without CaptureHTTP (tier wiring?)")
	}

	// The REAL admin is the audit row's author, not the account whose
	// session is making the request.
	middleware.Audit(ctx, d.Q, session.ImpersonatedBy, "impersonation.stop", session.UserID, "")

	if err := d.Auth.StopImpersonating(ctx, w, r, session); err != nil {
		return nil, fmt.Errorf("api: stop impersonating: %w", err)
	}
	return gen.StopImpersonating200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// ListAdminAudit implements GET /api/admin/audit.
func (d Deps) ListAdminAudit(ctx context.Context, _ gen.ListAdminAuditRequestObject) (gen.ListAdminAuditResponseObject, error) {
	rows, err := d.Q.ListAdminAudit(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]gen.AuditEntry, len(rows))
	for i, row := range rows {
		out[i] = gen.AuditEntry{
			Id:        row.ID,
			AdminId:   row.AdminID,
			AdminName: row.AdminName,
			Action:    row.Action,
			Target:    row.Target,
			Detail:    row.Detail,
			CreatedAt: row.CreatedAt.Time,
		}
	}
	return gen.ListAdminAudit200JSONResponse(out), nil
}

// CreateAdminAuditNote implements POST /api/admin/audit: an entry recorded
// by hand, for an admin action taken outside these routes.
func (d Deps) CreateAdminAuditNote(ctx context.Context, req gen.CreateAdminAuditNoteRequestObject) (gen.CreateAdminAuditNoteResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("CreateAdminAuditNote")
	}

	detail := ""
	if req.Body.Detail != nil {
		detail = *req.Body.Detail
	}
	middleware.Audit(ctx, d.Q, admin, req.Body.Action, req.Body.Target, detail)
	return gen.CreateAdminAuditNote200JSONResponse{Ok: gen.OkOkTrue}, nil
}
