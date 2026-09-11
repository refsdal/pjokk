package api

import (
	"context"
	"errors"
	"fmt"
	"net/mail"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// The operator console's user page (docs/superpowers/specs/
// 2026-09-11-admin-user-support-design.md): one person's families, how they
// sign in and where they are signed in, plus the support tools that act on
// them — change their login address, take the system-admin role away, sign
// one session out. Every write follows admin.go's rule: adminID, the audit
// row first and checked, then the change.
//
// Metadata only, like the family page: no log content, and no token or
// address — sessions come from auth.Service.UserSessions, which never
// returns either.

// userDetailRow is the existence check every user-page route runs first.
// The tombstone deleted accounts' records point at is not a person, and is
// not found here either.
func (d Deps) userDetailRow(ctx context.Context, id string) (dbgen.GetAdminUserDetailRow, bool, error) {
	row, err := d.Q.GetAdminUserDetail(ctx, dbgen.GetAdminUserDetailParams{ID: id, TombstoneID: db.TombstoneID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return row, false, nil
	case err != nil:
		return row, false, err
	}
	return row, true, nil
}

func serAdminUserDetailRow(row dbgen.GetAdminUserDetailRow) gen.AdminUser {
	return gen.AdminUser{
		Id:        row.ID,
		Name:      row.Name,
		Email:     row.Email,
		Role:      row.Role,
		Banned:    row.Banned,
		BanReason: row.BanReason,
		CreatedAt: row.CreatedAt.Time,
	}
}

// orNil turns an absent string into JSON null.
func orNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// GetAdminUserDetail implements GET /api/admin/users/{id}.
func (d Deps) GetAdminUserDetail(ctx context.Context, req gen.GetAdminUserDetailRequestObject) (gen.GetAdminUserDetailResponseObject, error) {
	row, ok, err := d.userDetailRow(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.GetAdminUserDetail404JSONResponse(notFound()), nil
	}

	families, err := d.Q.AdminUserFamilies(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	providers, err := d.Q.AdminUserProviders(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	sessions, err := d.Auth.UserSessions(ctx, req.Id)
	if err != nil {
		return nil, err
	}

	// The operator behind an impersonated session, by name. Rare, and a
	// handful of rows at most, so one lookup per distinct operator.
	operators := map[string]string{}
	for _, s := range sessions {
		if s.ImpersonatedBy == "" {
			continue
		}
		if _, seen := operators[s.ImpersonatedBy]; seen {
			continue
		}
		op, err := d.Q.GetAdminUser(ctx, s.ImpersonatedBy)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			operators[s.ImpersonatedBy] = "a deleted operator"
		case err != nil:
			return nil, err
		case op.Name != "":
			operators[s.ImpersonatedBy] = op.Name
		default:
			operators[s.ImpersonatedBy] = op.Email
		}
	}

	user := serAdminUserDetailRow(row)
	out := gen.AdminUserDetail{
		Id:          user.Id,
		Name:        user.Name,
		Email:       user.Email,
		Role:        user.Role,
		Banned:      user.Banned,
		BanReason:   user.BanReason,
		CreatedAt:   user.CreatedAt,
		HasPassword: row.HasPassword,
		Families:    make([]gen.AdminUserFamily, 0, len(families)),
		Providers:   make([]gen.AdminUserProvider, 0, len(providers)),
		Sessions:    make([]gen.AdminSession, 0, len(sessions)),
	}
	for _, f := range families {
		out.Families = append(out.Families, gen.AdminUserFamily{FamilyId: f.FamilyID, Name: f.Name, Role: f.Role})
	}
	for _, p := range providers {
		out.Providers = append(out.Providers, gen.AdminUserProvider{Provider: p.Provider, LinkedAt: p.CreatedAt.Time})
	}
	for _, s := range sessions {
		out.Sessions = append(out.Sessions, gen.AdminSession{
			Id:                 s.ID,
			UserAgent:          orNil(s.UserAgent),
			CreatedAt:          s.CreatedAt,
			LastActiveAt:       s.LastActiveAt,
			ExpiresAt:          s.ExpiresAt,
			FamilyName:         orNil(s.FamilyName),
			ImpersonatedByName: orNil(operators[s.ImpersonatedBy]),
		})
	}
	return gen.GetAdminUserDetail200JSONResponse(out), nil
}

// ChangeAdminUserEmail implements POST /api/admin/users/{id}/email. The
// address changes and nothing else: sessions and a linked Google account
// stay (auth.Service.ChangeEmail's doc comment says why that is safe).
func (d Deps) ChangeAdminUserEmail(ctx context.Context, req gen.ChangeAdminUserEmailRequestObject) (gen.ChangeAdminUserEmailResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("ChangeAdminUserEmail")
	}
	row, ok, err := d.userDetailRow(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.ChangeAdminUserEmail404JSONResponse(notFound()), nil
	}

	email := auth.NormalizeEmail(req.Body.Email)
	if parsed, err := mail.ParseAddress(email); err != nil || parsed.Address != email {
		return gen.ChangeAdminUserEmail400JSONResponse(gen.Error{Error: "That is not an email address", Code: "VALIDATION"}), nil
	}
	if email == row.Email {
		return gen.ChangeAdminUserEmail400JSONResponse(gen.Error{Error: "That is already their address", Code: "UNCHANGED"}), nil
	}
	// Before the audit row, so a refused change leaves no entry describing
	// a change that never happened. The unique index still has the last
	// word, below.
	inUse, err := d.Q.EmailInUseByAnother(ctx, dbgen.EmailInUseByAnotherParams{Email: email, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if inUse {
		return gen.ChangeAdminUserEmail409JSONResponse(emailTaken()), nil
	}

	if err := audit(ctx, d.Q, admin, "user.email.change", req.Id, fmt.Sprintf("%s → %s", row.Email, email)); err != nil {
		return nil, err
	}
	if err := d.Auth.ChangeEmail(ctx, req.Id, email); err != nil {
		if errors.Is(err, auth.ErrEmailTaken) {
			return gen.ChangeAdminUserEmail409JSONResponse(emailTaken()), nil
		}
		return nil, err
	}
	row.Email = email
	return gen.ChangeAdminUserEmail200JSONResponse(serAdminUserDetailRow(row)), nil
}

func emailTaken() gen.Error {
	return gen.Error{Error: "That address belongs to another account", Code: "EMAIL_TAKEN"}
}

// RevokeAdminUserRole implements DELETE /api/admin/users/{id}/role: the
// system-admin role taken away. There is deliberately no route that grants
// it — a stolen operator session must not be able to mint itself a second,
// permanent admin account (e2e makeSysadmin's standing rule).
func (d Deps) RevokeAdminUserRole(ctx context.Context, req gen.RevokeAdminUserRoleRequestObject) (gen.RevokeAdminUserRoleResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Id == admin {
		return gen.RevokeAdminUserRole400JSONResponse(refused("You cannot revoke your own system-admin role")), nil
	}
	row, ok, err := d.userDetailRow(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if !ok || row.Role == nil || *row.Role != auth.RoleSystemAdmin {
		return gen.RevokeAdminUserRole404JSONResponse(notFound()), nil
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	// Lock the active admins, then count them. Two operators revoking each
	// other at once would otherwise each see two and both succeed; with the
	// locks (taken in id order, so the two transactions cannot deadlock)
	// the second waits, re-reads, and sees one. A banned admin is not
	// counted — revoking one never takes away the last working account.
	active, err := qtx.LockActiveSystemAdmins(ctx)
	if err != nil {
		return nil, err
	}
	if slices.Contains(active, req.Id) && len(active) <= 1 {
		return gen.RevokeAdminUserRole409JSONResponse(gen.Error{
			Error: "The console needs at least one system admin",
			Code:  "LAST_ADMIN",
		}), nil
	}

	if err := audit(ctx, qtx, admin, "user.role.revoke", req.Id, row.Email); err != nil {
		return nil, err
	}
	n, err := qtx.RevokeSystemAdmin(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		// Revoked by someone else while this request waited for the locks.
		return gen.RevokeAdminUserRole404JSONResponse(notFound()), nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	// After the commit, because it goes through Limen's own handle: the
	// sessions they were driving as somebody else end with the role.
	// RequireSysadmin re-reads the role on every request, so their own
	// sessions lose the console on the next one.
	if err := d.Auth.RevokeImpersonatedSessions(ctx, req.Id); err != nil {
		return nil, err
	}
	return gen.RevokeAdminUserRole204Response{}, nil
}

// RevokeAdminUserSession implements DELETE
// /api/admin/users/{id}/sessions/{sessionId}: one session signed out, the
// rest left alone. "Sign out everywhere" is the existing
// POST .../sessions/revoke.
func (d Deps) RevokeAdminUserSession(ctx context.Context, req gen.RevokeAdminUserSessionRequestObject) (gen.RevokeAdminUserSessionResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if _, ok, err := d.userDetailRow(ctx, req.Id); err != nil {
		return nil, err
	} else if !ok {
		return gen.RevokeAdminUserSession404JSONResponse(notFound()), nil
	}

	// The session must be theirs; its user agent names it in the trail.
	sessions, err := d.Auth.UserSessions(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(sessions, func(s auth.SessionInfo) bool { return s.ID == req.SessionId })
	if i < 0 {
		return gen.RevokeAdminUserSession404JSONResponse(notFound()), nil
	}

	if err := audit(ctx, d.Q, admin, "user.session.revoke", req.Id, sessions[i].UserAgent); err != nil {
		return nil, err
	}
	if err := d.Auth.RevokeSession(ctx, req.Id, req.SessionId); err != nil {
		if errors.Is(err, auth.ErrSessionNotFound) {
			return gen.RevokeAdminUserSession404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	return gen.RevokeAdminUserSession204Response{}, nil
}
