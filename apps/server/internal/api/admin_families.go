package api

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/auth"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Admin-side family management —
// docs/superpowers/specs/2026-09-08-admin-family-management-design.md.
// Unlike its neighbour admin.go this file ports nothing: the TypeScript
// console never had a family detail page, and the operator's only tools
// were "list" and "destroy".
//
// Everything here is tierSysadmin (api.go's operationAuthTiers) and every
// mutation writes a CHECKED admin_audit row before the change it records,
// through admin.go's audit helper. See that file's "Auditing" section for
// why the console uses the propagating version rather than
// middleware.Audit.
//
// # Why these routes exist at all
//
// A system admin is not a member of any family, so the family-admin surface
// (tierAdmin: /api/family/members, /api/invites, /api/keys) is closed to
// them — RequireFamily answers NO_FAMILY. Two alternatives were rejected in
// the design: letting an operator adopt a family as their session's active
// one (which makes "a sysadmin is not a member" false and files operator
// actions as ordinary family-admin ones), and doing everything through
// impersonation (which fails precisely in the cases the tooling is for — a
// family with no admin left — and shows the family a banner for routine
// support). Dedicated routes are the only arrangement where the audit
// trail stays truthful.
//
// # Metadata only
//
// GetAdminFamily deliberately returns no log content and no per-type
// counts. Nothing derived from a child's health record enters the console,
// which is what lets apps/landing/src/legal/privacy.tsx stay as it is —
// it promises an audit trail of administrative actions and says nothing
// about operator access to health data. Impersonation remains the only
// route to a family's entries, and it is already audited and already shows
// the family a banner. Adding a log view here means adding a clause there
// first.

// serAdminFamilyMember converts one ListAdminFamilyMembers row to the wire
// shape. Compare babies.go's ListFamilyMembers: the console wants joinedAt
// and the account's ban state (support questions) and has no use for the
// avatar or push flag (in-app rendering).
func serAdminFamilyMember(row dbgen.ListAdminFamilyMembersRow) gen.AdminFamilyMember {
	return gen.AdminFamilyMember{
		MemberId: row.MemberID,
		UserId:   row.UserID,
		Name:     row.Name,
		Email:    row.Email,
		Role:     row.Role,
		JoinedAt: row.JoinedAt.Time,
		Banned:   row.Banned,
	}
}

// requireFamily is the existence check every /api/admin/families/{id}/…
// route runs first, returning the row so a caller can use its name as audit
// detail. A missing family is reported as (nil, nil) — the caller answers
// its own 404, since each operation has its own generated response type.
func (d Deps) requireFamily(ctx context.Context, id string) (*dbgen.GetAdminFamilyRowRow, error) {
	row, err := d.Q.GetAdminFamilyRow(ctx, id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, err
	}
	return &row, nil
}

// CreateAdminFamily implements POST /api/admin/families: manual family
// creation, with three behaviours chosen by the body (see the spec summary
// in openapi/pjokk.yaml).
//
// # Why this is not a transaction
//
// Both writes go through Limen, which opens its own transaction per call —
// the same constraint invites.go documents for redeem, where nesting would
// have produced two independent commit points. So the steps are ORDERED so
// that a partial failure is benign rather than compensated for:
//
//  1. Resolve or create the first-admin account. A memberless account is
//     inert — allowOrgCreation refuses it a family and it holds no
//     membership to reach one through — and jobs.PurgeOrphanUsers removes
//     it after seven days.
//  2. Create the family, which atomically installs the admin membership.
//
// There is deliberately no compensating DELETE. That pattern was removed in
// the Go port (CLAUDE.md's Postgres notes) and the state it would clean up
// already cleans itself up.
//
// If the parent later signs in with a DIFFERENT address than the one
// provisioned, Limen creates a separate account (its OAuth plugin links by
// email), the pre-created row is purged within the week, and the operator
// mints an invite from the family detail page.
func (d Deps) CreateAdminFamily(ctx context.Context, req gen.CreateAdminFamilyRequestObject) (gen.CreateAdminFamilyResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("CreateAdminFamily")
	}

	name := strings.TrimSpace(req.Body.Name)
	if name == "" {
		return gen.CreateAdminFamily400JSONResponse(gen.Error{
			Error: "Family name is required",
			Code:  "VALIDATION",
		}), nil
	}

	ownerID, created, resp := d.resolveFirstAdmin(ctx, admin, req.Body)
	if resp != nil {
		return resp, nil
	}

	// Two different creations, and the difference matters. With a first
	// admin the family is created FOR them and they are its only member.
	// Without one the family must end up EMPTY — the operator must not be
	// left inside a family they created for someone else, which would hand
	// them ordinary in-app access to a child's health record and quietly
	// undo this console's metadata-only rule. Limen cannot create an
	// ownerless organization, so CreateEmptyFamily removes the membership it
	// insists on; see its doc comment.
	var familyID string
	if ownerID != "" {
		familyID, err = d.Auth.CreateFamilyForUser(ctx, ownerID, name)
	} else {
		familyID, err = d.Auth.CreateEmptyFamily(ctx, admin, name)
	}
	if err != nil {
		return nil, fmt.Errorf("api: create family %q: %w", name, err)
	}

	// Audit after the create rather than before, uniquely on this route:
	// "audit first" elsewhere records an id the caller already knows, and
	// here the id does not exist until the family does. The window is one
	// statement wide and the failure mode is the safe one — a created
	// family with no entry is visible in the list, whereas the alternative
	// is an entry for an id that never existed.
	if err := audit(ctx, d.Q, admin, "family.create", familyID, name); err != nil {
		return nil, err
	}

	out := gen.AdminFamilyCreated{Id: familyID, Name: name}

	if row, err := d.Q.GetAdminFamilyRow(ctx, familyID); err == nil {
		out.Slug = row.Slug
	} else {
		return nil, err
	}

	switch {
	case ownerID != "":
		email := ""
		if req.Body.AdminEmail != nil {
			email = auth.NormalizeEmail(string(*req.Body.AdminEmail))
		}
		out.FirstAdmin = &gen.AdminFamilyFirstAdmin{
			UserId:         ownerID,
			Email:          email,
			AccountCreated: created,
		}
	default:
		// An admin-role code, because whoever redeems it is the person who
		// will run this family — a member-role invite would leave it in the
		// stranded state the console badges.
		role := gen.CreateInviteRoleAdmin
		invite, err := d.createInvite(ctx, familyID, admin, &gen.CreateInvite{Role: &role})
		if err != nil {
			return nil, err
		}
		if err := audit(ctx, d.Q, admin, "family.invite.create", familyID,
			fmt.Sprintf("%s %s", invite.Code, invite.Role)); err != nil {
			return nil, err
		}
		out.Invite = &invite
	}

	return gen.CreateAdminFamily201JSONResponse(out), nil
}

// resolveFirstAdmin turns CreateAdminFamily's body into the user id that
// will run the new family. It returns ("", false, nil) when the caller
// named no admin — the invite path — and a non-nil response when the
// request must be refused.
//
// The createAccount flag is deliberately explicit rather than implied by
// "no account exists". A support operator typing an address by hand gets
// the address wrong sometimes, and silently provisioning an account for the
// typo would leave a stray user and a family nobody can reach; a 404 is
// recoverable in one keystroke.
func (d Deps) resolveFirstAdmin(ctx context.Context, admin string, body *gen.CreateAdminFamily) (string, bool, gen.CreateAdminFamilyResponseObject) {
	if body.AdminEmail == nil || strings.TrimSpace(string(*body.AdminEmail)) == "" {
		return "", false, nil
	}
	email := auth.NormalizeEmail(string(*body.AdminEmail))

	switch id, err := d.Q.GetUserIDByEmail(ctx, email); {
	case err == nil:
		return id, false, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return "", false, gen.CreateAdminFamily400JSONResponse(gen.Error{
			Error: "Could not look up that address",
			Code:  "VALIDATION",
		})
	}

	createAccount := body.CreateAccount != nil && *body.CreateAccount
	if !createAccount {
		return "", false, gen.CreateAdminFamily404JSONResponse(gen.Error{
			Error: "No account for that email",
			Code:  "NOT_FOUND",
		})
	}

	adminName := ""
	if body.AdminName != nil {
		adminName = strings.TrimSpace(*body.AdminName)
	}
	if adminName == "" {
		return "", false, gen.CreateAdminFamily400JSONResponse(gen.Error{
			Error: "adminName is required when creating an account",
			Code:  "VALIDATION",
		})
	}

	// An EMPTY password on purpose: users.password stays NULL, which Limen's
	// credential plugin reads as "signed up through OAuth". The person
	// claims the account by signing in with Google on this address (the
	// OAuth plugin links by email), and SetPassword can still establish a
	// first password later. A random throwaway hash would have locked the
	// account out of its own recovery path — see auth.CreateUser.
	userID, err := d.Auth.CreateUser(ctx, adminName, email, "")
	if err != nil {
		if errors.Is(err, auth.ErrEmailTaken) {
			// Raced with another signup between the lookup and here.
			return "", false, gen.CreateAdminFamily400JSONResponse(gen.Error{
				Error: "An account already exists for that email",
				Code:  "VALIDATION",
			})
		}
		return "", false, gen.CreateAdminFamily400JSONResponse(gen.Error{
			Error: "Could not create that account",
			Code:  "VALIDATION",
		})
	}

	if err := audit(ctx, d.Q, admin, "user.create", userID, email); err != nil {
		// The account exists but the trail does not. Refusing here would
		// leave the same orphan a mid-flight failure leaves, and the purge
		// handles both; reporting it is what matters.
		return "", false, gen.CreateAdminFamily400JSONResponse(gen.Error{
			Error: "Could not record the audit entry",
			Code:  "VALIDATION",
		})
	}
	return userID, true, nil
}

// GetAdminFamily implements GET /api/admin/families/{id}: one payload for
// the whole detail page rather than four list endpoints, because it renders
// as one screen. Metadata only — see this file's header.
func (d Deps) GetAdminFamily(ctx context.Context, req gen.GetAdminFamilyRequestObject) (gen.GetAdminFamilyResponseObject, error) {
	family, err := d.requireFamily(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if family == nil {
		return gen.GetAdminFamily404JSONResponse(notFound()), nil
	}

	memberRows, err := d.Q.ListAdminFamilyMembers(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	babyRows, err := d.Q.ListBabies(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	inviteRows, err := d.Q.ListInvites(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	keyRows, err := d.Q.ListAPIKeys(ctx, req.Id)
	if err != nil {
		return nil, err
	}

	members := make([]gen.AdminFamilyMember, len(memberRows))
	for i, row := range memberRows {
		members[i] = serAdminFamilyMember(row)
	}
	babies := make([]gen.Baby, len(babyRows))
	for i, row := range babyRows {
		babies[i] = serBaby(row)
	}
	invites := make([]gen.Invite, len(inviteRows))
	for i, row := range inviteRows {
		invites[i] = serInvite(row, d.AppURL)
	}
	keys := make([]gen.ApiKey, len(keyRows))
	for i, row := range keyRows {
		keys[i] = serAPIKey(row)
	}

	return gen.GetAdminFamily200JSONResponse{
		Id:         family.ID,
		Name:       family.Name,
		Slug:       family.Slug,
		Plan:       family.Plan,
		CreatedAt:  family.CreatedAt.Time,
		LastFeedAt: tsPtr(family.LastFeedAt),
		Members:    members,
		Babies:     babies,
		Invites:    invites,
		ApiKeys:    keys,
	}, nil
}

// UpdateAdminFamily implements PATCH /api/admin/families/{id}: rename.
//
// The audit detail records BOTH names ("old → new"). A trail that recorded
// only the new one would be unreadable a month later, when the question is
// which family a row is about.
func (d Deps) UpdateAdminFamily(ctx context.Context, req gen.UpdateAdminFamilyRequestObject) (gen.UpdateAdminFamilyResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("UpdateAdminFamily")
	}

	family, err := d.requireFamily(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if family == nil {
		return gen.UpdateAdminFamily404JSONResponse(notFound()), nil
	}

	name := strings.TrimSpace(req.Body.Name)
	if err := audit(ctx, d.Q, admin, "family.rename", req.Id,
		fmt.Sprintf("%s → %s", family.Name, name)); err != nil {
		return nil, err
	}

	n, err := d.Q.RenameOrganization(ctx, dbgen.RenameOrganizationParams{ID: req.Id, Name: name})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.UpdateAdminFamily404JSONResponse(notFound()), nil
	}
	return gen.UpdateAdminFamily200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// AddAdminFamilyMember implements POST /api/admin/families/{id}/members.
//
// It resolves an EXISTING account only. Creating one here would give the
// operator a second, quieter account-provisioning path with none of
// CreateAdminFamily's explicit createAccount gate — and a typo would leave
// a stray user in someone else's family rather than a recoverable error.
func (d Deps) AddAdminFamilyMember(ctx context.Context, req gen.AddAdminFamilyMemberRequestObject) (gen.AddAdminFamilyMemberResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("AddAdminFamilyMember")
	}

	family, err := d.requireFamily(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if family == nil {
		return gen.AddAdminFamilyMember404JSONResponse(notFound()), nil
	}

	email := auth.NormalizeEmail(string(req.Body.Email))
	userID, err := d.Q.GetUserIDByEmail(ctx, email)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return gen.AddAdminFamilyMember404JSONResponse(gen.Error{
			Error: "No account for that email",
			Code:  "NOT_FOUND",
		}), nil
	case err != nil:
		return nil, err
	}

	// Checked before the write because Limen's AddMember reports a duplicate
	// as an opaque failure, which would surface as a 500 for what is an
	// ordinary, explainable refusal.
	members, err := d.Q.ListAdminFamilyMembers(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if m.UserID == userID {
			return gen.AddAdminFamilyMember400JSONResponse(
				refused("That account is already a member of this family")), nil
		}
	}

	role := string(req.Body.Role)
	if err := audit(ctx, d.Q, admin, "family.member.add", req.Id,
		fmt.Sprintf("%s as %s", email, role)); err != nil {
		return nil, err
	}

	if err := d.Auth.AddMember(ctx, req.Id, userID, role); err != nil {
		if errors.Is(err, auth.ErrUnknownRole) {
			return gen.AddAdminFamilyMember400JSONResponse(refused("Unknown role")), nil
		}
		return nil, fmt.Errorf("api: add %s to family %s: %w", userID, req.Id, err)
	}
	return gen.AddAdminFamilyMember200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// RemoveAdminFamilyMember implements
// DELETE /api/admin/families/{id}/members/{memberId}.
//
// The last-admin guard applies to system admins too. It is tempting to let
// an operator override it — they can already delete the whole family — but
// the two outcomes are not comparable: a deleted family is gone and
// understood, while a family with no admin still works for everyone in it
// and silently cannot be administered, which is the exact state this
// console exists to repair. Promoting someone else first is always
// available.
func (d Deps) RemoveAdminFamilyMember(ctx context.Context, req gen.RemoveAdminFamilyMemberRequestObject) (gen.RemoveAdminFamilyMemberResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	family, err := d.requireFamily(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if family == nil {
		return gen.RemoveAdminFamilyMember404JSONResponse(notFound()), nil
	}

	member, ok, err := d.findFamilyMember(ctx, req.Id, req.MemberId)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.RemoveAdminFamilyMember404JSONResponse(notFound()), nil
	}

	// Anticipated BEFORE the audit write, not merely caught after it. The
	// guard inside auth.RemoveMember's transaction stays authoritative, but
	// reaching it costs an audit row describing a removal that was then
	// refused — a false entry in an append-only trail, and the most likely
	// single row an operator will ever produce here, since "remove the last
	// admin" is exactly what someone tries when a family looks wrong.
	stranded, err := d.wouldStrandFamily(ctx, req.Id, member.Role, "")
	if err != nil {
		return nil, err
	}
	if stranded {
		return gen.RemoveAdminFamilyMember400JSONResponse(
			refused("Cannot remove the family's last admin — promote someone else first")), nil
	}

	if err := audit(ctx, d.Q, admin, "family.member.remove", req.Id, member.Email); err != nil {
		return nil, err
	}

	if err := d.Auth.RemoveMember(ctx, req.Id, req.MemberId); err != nil {
		switch {
		case errors.Is(err, auth.ErrLastAdmin):
			return gen.RemoveAdminFamilyMember400JSONResponse(
				refused("Cannot remove the family's last admin — promote someone else first")), nil
		case errors.Is(err, auth.ErrMemberNotInFamily):
			return gen.RemoveAdminFamilyMember404JSONResponse(notFound()), nil
		}
		return nil, fmt.Errorf("api: remove member %s: %w", req.MemberId, err)
	}
	return gen.RemoveAdminFamilyMember200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// SetAdminFamilyMemberRole implements
// POST /api/admin/families/{id}/members/{memberId}/role.
func (d Deps) SetAdminFamilyMemberRole(ctx context.Context, req gen.SetAdminFamilyMemberRoleRequestObject) (gen.SetAdminFamilyMemberRoleResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errNoRequestBody("SetAdminFamilyMemberRole")
	}

	family, err := d.requireFamily(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if family == nil {
		return gen.SetAdminFamilyMemberRole404JSONResponse(notFound()), nil
	}

	member, ok, err := d.findFamilyMember(ctx, req.Id, req.MemberId)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.SetAdminFamilyMemberRole404JSONResponse(notFound()), nil
	}

	role := string(req.Body.Role)

	// See RemoveAdminFamilyMember for why this is checked before the audit
	// row rather than after the write fails.
	stranded, err := d.wouldStrandFamily(ctx, req.Id, member.Role, role)
	if err != nil {
		return nil, err
	}
	if stranded {
		return gen.SetAdminFamilyMemberRole400JSONResponse(
			refused("Cannot demote the family's last admin — promote someone else first")), nil
	}

	if err := audit(ctx, d.Q, admin, "family.member.role", req.Id,
		fmt.Sprintf("%s: %s → %s", member.Email, member.Role, role)); err != nil {
		return nil, err
	}

	if err := d.Auth.SetMemberRole(ctx, req.Id, req.MemberId, role); err != nil {
		switch {
		case errors.Is(err, auth.ErrLastAdmin):
			return gen.SetAdminFamilyMemberRole400JSONResponse(
				refused("Cannot demote the family's last admin — promote someone else first")), nil
		case errors.Is(err, auth.ErrMemberNotInFamily):
			return gen.SetAdminFamilyMemberRole404JSONResponse(notFound()), nil
		case errors.Is(err, auth.ErrUnknownRole):
			return gen.SetAdminFamilyMemberRole400JSONResponse(refused("Unknown role")), nil
		}
		return nil, fmt.Errorf("api: set role of member %s: %w", req.MemberId, err)
	}
	return gen.SetAdminFamilyMemberRole200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// wouldStrandFamily reports whether acting on a member holding currentRole
// would leave the family with nobody able to administer it — the same
// condition auth.RemoveMember and auth.SetMemberRole enforce inside their
// transactions, evaluated early so the console can refuse WITHOUT first
// recording an action that will not happen.
//
// newRole is "" for a removal and the requested role for a role change; the
// asymmetry mirrors the guard being mirrored, where only a change AWAY from
// admin is a demotion (re-setting an admin to admin, or promoting a member,
// never shrinks the count).
//
// This is not the authoritative check and is not trying to be. Between this
// count and the write, another request could remove the family's other
// admin; the transaction's own guard catches that and the route still
// answers 400, having written one audit row it did not need. Duplicating
// the condition here buys a clean trail in the overwhelmingly common case,
// not correctness — the correctness lives where the lock is.
func (d Deps) wouldStrandFamily(ctx context.Context, familyID, currentRole, newRole string) (bool, error) {
	if !auth.IsPrivilegedRole(currentRole) {
		return false, nil
	}
	if newRole == auth.RoleAdmin {
		return false, nil
	}
	admins, err := d.Q.CountFamilyAdmins(ctx, familyID)
	if err != nil {
		return false, err
	}
	return admins <= 1, nil
}

// findFamilyMember looks one membership up WITHIN a family, which is the
// tenancy check for the two member routes: auth.Service reports a member
// that belongs to another family as ErrMemberNotInFamily, but only after
// the audit row has been written, and an entry describing a family the
// member was never in is worse than no entry.
func (d Deps) findFamilyMember(ctx context.Context, familyID, memberID string) (dbgen.ListAdminFamilyMembersRow, bool, error) {
	rows, err := d.Q.ListAdminFamilyMembers(ctx, familyID)
	if err != nil {
		return dbgen.ListAdminFamilyMembersRow{}, false, err
	}
	for _, row := range rows {
		if row.MemberID == memberID {
			return row, true, nil
		}
	}
	return dbgen.ListAdminFamilyMembersRow{}, false, nil
}

// CreateAdminFamilyInvite implements POST /api/admin/families/{id}/invites.
// Everything that defines an invite comes from invites.go's shared
// createInvite; this route only supplies the family and the creator.
func (d Deps) CreateAdminFamilyInvite(ctx context.Context, req gen.CreateAdminFamilyInviteRequestObject) (gen.CreateAdminFamilyInviteResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	family, err := d.requireFamily(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if family == nil {
		return gen.CreateAdminFamilyInvite404JSONResponse(notFound()), nil
	}

	invite, err := d.createInvite(ctx, req.Id, admin, req.Body)
	if err != nil {
		return nil, err
	}

	// After the write, like family.create and for the same reason: the code
	// does not exist until it is minted, and an audit row naming a code that
	// was never issued would be actively misleading.
	if err := audit(ctx, d.Q, admin, "family.invite.create", req.Id,
		fmt.Sprintf("%s %s", invite.Code, invite.Role)); err != nil {
		return nil, err
	}
	return gen.CreateAdminFamilyInvite201JSONResponse(invite), nil
}

// RevokeAdminFamilyInvite implements
// DELETE /api/admin/families/{id}/invites/{code}.
//
// The query is scoped by family id as well as code (queries/invites.sql's
// RevokeInvite), so a code belonging to another family affects zero rows
// and is answered 404 — the operator cannot revoke one family's invite
// while looking at another's page.
func (d Deps) RevokeAdminFamilyInvite(ctx context.Context, req gen.RevokeAdminFamilyInviteRequestObject) (gen.RevokeAdminFamilyInviteResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	if err := audit(ctx, d.Q, admin, "family.invite.revoke", req.Id, req.Code); err != nil {
		return nil, err
	}

	n, err := d.Q.RevokeInvite(ctx, dbgen.RevokeInviteParams{
		Code:      req.Code,
		FamilyID:  req.Id,
		RevokedAt: ts(d.Now()),
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.RevokeAdminFamilyInvite404JSONResponse(notFound()), nil
	}
	return gen.RevokeAdminFamilyInvite200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// RevokeAdminFamilyKey implements
// DELETE /api/admin/families/{id}/keys/{keyId}: the way to kill a leaked
// integration token without impersonating anyone. Family-scoped for the
// same reason the invite route is.
func (d Deps) RevokeAdminFamilyKey(ctx context.Context, req gen.RevokeAdminFamilyKeyRequestObject) (gen.RevokeAdminFamilyKeyResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}

	if err := audit(ctx, d.Q, admin, "family.key.revoke", req.Id, req.KeyId); err != nil {
		return nil, err
	}

	n, err := d.Q.RevokeAPIKey(ctx, dbgen.RevokeAPIKeyParams{
		ID:        req.KeyId,
		FamilyID:  req.Id,
		RevokedAt: ts(d.Now()),
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.RevokeAdminFamilyKey404JSONResponse(notFound()), nil
	}
	return gen.RevokeAdminFamilyKey200JSONResponse{Ok: gen.OkOkTrue}, nil
}
