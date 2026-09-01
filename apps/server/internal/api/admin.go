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
	"github.com/refsdal/pjokk/server/internal/auth"
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
// Every mutation writes an admin_audit row BEFORE the change it records,
// and that write is CHECKED: a failure aborts the request with a 500 and
// nothing is mutated. Not middleware.Audit — that helper deliberately
// swallows its error, which is right for exactly one caller
// (middleware.RequireFamily's `impersonated.write` trail, where an audit
// failure must not deny a caretaker the ability to log a feed) and wrong
// for an admin console, whose whole purpose is that destructive actions
// leave a record. The TypeScript predecessor awaited its audit() and let a
// failure propagate; this restores that.
//
// Ordering is audit-first everywhere. Where a transaction already exists
// (DeleteAdminFamily, DeleteAdminUser) both writes are in it, so the pair
// is atomic. Where there is none, "audit first" means a failed mutation can
// leave a row describing an action that did not happen — the safe direction:
// an unexplained entry invites a question, a silent mutation does not.
//
// The admin_id is always the REAL operator: for the impersonation pair that
// means the system admin, never the account being impersonated
// (StopImpersonating reads it from the session's impersonated_by marker,
// which only the server writes), and adminID below applies the same rule to
// every other route.

// refused is the 400 envelope apps/api/src/routes/admin.ts used for
// "this account may not be deleted" (self, or the tombstone). The same code
// covers the guards this port adds — self-ban and impersonating
// yourself/a banned account — with a message that says which.
func refused(message string) gen.Error {
	return gen.Error{Error: message, Code: "REFUSED"}
}

// audit appends one row to the system-admin trail and PROPAGATES a failure,
// unlike middleware.Audit — see this file's "Auditing" section for why the
// console needs the checked version and who still wants the swallowing one.
//
// q is a parameter rather than d.Q so a caller inside a transaction can pass
// its own querier and get the row committed with the change it describes.
// An empty detail is stored as NULL.
func audit(ctx context.Context, q *dbgen.Queries, adminID, action, target, detail string) error {
	params := dbgen.InsertAdminAuditParams{AdminID: adminID, Action: action, Target: target}
	if detail != "" {
		params.Detail = &detail
	}
	if err := q.InsertAdminAudit(ctx, params); err != nil {
		return fmt.Errorf("api: write audit entry %q: %w", action, err)
	}
	return nil
}

// adminID is who is ACCOUNTABLE for a tierSysadmin request — the human
// whose name belongs on its audit row and whom the "not yourself" guards
// measure against.
//
// During impersonation that is the operator behind the session, not the
// account being impersonated. Reaching an admin route from an impersonated
// session takes one sysadmin impersonating another (an ordinary target's
// session fails RequireSysadmin), which is narrow but not impossible — and
// a trail that blamed the impersonated admin for the operator's own actions
// would be worse than no trail. middleware.RequireFamily's
// `impersonated.write` entries do not cover this surface: tierSysadmin has
// no family gate, so nothing else on these routes records the second
// identity.
//
// RequireSysadmin guarantees a session, so a missing one is a wiring bug and
// reported as one rather than silently attributing an audit row to "".
func adminID(ctx context.Context) (string, error) {
	session := middleware.SessionFromContext(ctx)
	if session == nil {
		return "", errors.New("api: admin route reached with no session (RequireSysadmin not wired?)")
	}
	if session.ImpersonatedBy != "" {
		return session.ImpersonatedBy, nil
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

	// One transaction, and the audit insert is CHECKED rather than
	// best-effort (middleware.Audit swallows its error, which is right for
	// the impersonated-write trail and wrong here): destroying a family
	// without a record of who did it is not an outcome worth having, so a
	// trail failure aborts the delete instead.
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	if err := audit(ctx, qtx, admin, "family.delete", req.Id, name); err != nil {
		return nil, err
	}
	// Zero rows means the family disappeared between the lookup above and
	// this DELETE (a concurrent delete). Answered as the same 404 the
	// lookup would have given rather than a 200 for a delete that deleted
	// nothing.
	n, err := qtx.DeleteOrganization(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteAdminFamily404JSONResponse(notFound()), nil
	}
	if err := tx.Commit(ctx); err != nil {
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

	// Before the transaction, because it goes through Limen rather than our
	// pool: any session this account is DRIVING through impersonation
	// belongs to the target user, so the users-row delete below cascades
	// neither it nor anything else away. Doing it first means a delete that
	// then fails has only cost the operator their impersonated sessions —
	// the harmless direction.
	if err := d.Auth.RevokeImpersonatedSessions(ctx, req.Id); err != nil {
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
	// back would be a lie.
	if err := audit(ctx, qtx, admin, "user.delete", req.Id, target.Email); err != nil {
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

	if err := audit(ctx, d.Q, admin, "user.ban", req.Id, target.Email); err != nil {
		return nil, err
	}

	if err := d.Q.BanAdminUser(ctx, dbgen.BanAdminUserParams{ID: req.Id, BanReason: reason}); err != nil {
		return nil, err
	}
	// Order matters, and not for the obvious reason. The sessions this user
	// is DRIVING as somebody else belong to the impersonated user, so
	// RevokeAllSessions never sees them — but it does revoke the ADMIN
	// session each impersonation row points at, and `impersonation`
	// cascades on that token (00003). Revoking their own sessions first
	// would therefore delete the very rows the sweep reads, leaving the
	// impersonated sessions alive with nothing left to find them by.
	if err := d.Auth.RevokeImpersonatedSessions(ctx, req.Id); err != nil {
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

	if err := audit(ctx, d.Q, admin, "user.unban", req.Id, target.Email); err != nil {
		return nil, err
	}

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

	if err := audit(ctx, d.Q, admin, "user.password.set", req.Id, target.Email); err != nil {
		return nil, err
	}

	if err := d.Auth.SetPassword(ctx, req.Id, req.Body.Password); err != nil {
		// A password the credential policy refuses is the caller's mistake,
		// not the server's. The spec's own 8..128 bound is checked before
		// this handler runs; auth's policy (Limen's configured one: an
		// uppercase letter and a number too) is not expressible as a
		// JSON-Schema constraint the client could pre-check, so it arrives
		// here and is reported the same way the spec layer reports its own
		// rejections.
		var policy *auth.PasswordPolicyError
		if errors.As(err, &policy) {
			return gen.SetAdminUserPassword400JSONResponse(gen.Error{
				Error: "Password " + policy.Requirement,
				Code:  "VALIDATION",
			}), nil
		}
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

	if err := audit(ctx, d.Q, admin, "user.sessions.revoke", req.Id, target.Email); err != nil {
		return nil, err
	}

	// "Signed out everywhere" has to include the sessions they are driving
	// as somebody else, and that sweep must run FIRST — see BanAdminUser
	// for why revoking their own sessions first would destroy the rows it
	// reads.
	if err := d.Auth.RevokeImpersonatedSessions(ctx, req.Id); err != nil {
		return nil, err
	}
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
	// Reachable only when one sysadmin is impersonating another (an
	// ordinary target's session fails RequireSysadmin). auth.Impersonate
	// refuses to chain too, but with a plain error — a 500 for what is an
	// ordinary, explainable refusal.
	if session.ImpersonatedBy != "" {
		return gen.ImpersonateAdminUser400JSONResponse(
			refused("Cannot impersonate from an impersonated session")), nil
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

	if err := audit(ctx, d.Q, session.UserID, "user.impersonate", req.Id, target.Email); err != nil {
		return nil, err
	}

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
	if err := audit(ctx, d.Q, session.ImpersonatedBy, "impersonation.stop", session.UserID, ""); err != nil {
		return nil, err
	}

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
	// Checked, obviously: this endpoint IS the write. Answering {ok:true}
	// for a row that was never stored would be the worst version of the
	// best-effort trail.
	if err := audit(ctx, d.Q, admin, req.Body.Action, req.Body.Target, detail); err != nil {
		return nil, err
	}
	return gen.CreateAdminAuditNote200JSONResponse{Ok: gen.OkOkTrue}, nil
}
