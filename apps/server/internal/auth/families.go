package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/thecodearcher/limen"
	"github.com/thecodearcher/limen/plugins/organization"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file is package auth's organization surface: creating families and
// moving members between them. An organization IS a family — see auth.go.
//
// Two invariants live here rather than in any caller, because both must hold
// whichever caller reaches them: a family is never left without an admin
// (ErrLastAdmin, enforced inside the transaction, not merely checked before
// it), and an uninvited account cannot create one (allowOrgCreation, which
// is what actually keeps the alpha closed).

// allowOrgCreation is the Go-side port of apps/api/src/infrastructure/
// auth.ts's allowUserToCreateOrganization, wired in as
// organization.WithAllowOrgCreation (see New). A system admin may always
// create a family; anyone else may do so exactly once, self-serve, while
// they hold NO existing membership AND OPEN_SIGNUP is on — the founder
// bootstrap window. Under closed signup nobody self-serves: an uninvited
// OAuth account (now that OAuth signup is open) is family-less too, and this
// is the guard that keeps it from minting itself a free family. After a first
// family, joining another goes through an invite code, never a second
// self-service create. Both entry points (this package's own CreateFamily,
// used by the invite/admin flows and tests, and Limen's own POST
// /organizations the SPA's family switcher calls) run through
// organization.API.CreateOrganization, which checks this hook, so the rule
// cannot be bypassed by hitting one path instead of the other.
//
// Fails CLOSED (false) on a query error: an unreadable user cannot be
// verified as either a system admin or family-less, and "deny" is the safe
// side of that ambiguity — never "allow, and find out later."
func allowOrgCreation(ctx context.Context, q *gen.Queries, userID string, openSignup bool) bool {
	// A system administrator creating a family FOR somebody else. The
	// creator being checked here is that somebody — typically an account
	// provisioned seconds ago, which every rule below would refuse — so the
	// authority has to arrive out of band. It can only have been put there
	// by CreateFamilyForUser; see sysadminCreateKey.
	if hasSysadminCreate(ctx) {
		return true
	}
	role, err := q.GetUserRole(ctx, userID)
	if err != nil {
		return false
	}
	if role == RoleSystemAdmin {
		return true
	}
	memberships, err := q.CountMembershipsForUser(ctx, userID)
	if err != nil {
		return false
	}
	// A family-less non-admin may self-create ONLY during the OPEN_SIGNUP
	// founder-bootstrap window. Under closed signup an uninvited OAuth
	// account is family-less too, and must not be able to mint a free family
	// — it stays inert and the orphan purge removes it.
	return memberships == 0 && openSignup
}

// sysadminCreateKey marks a context as carrying a system administrator's
// authority to create a family on somebody else's behalf. allowOrgCreation
// honours it before its ordinary rules.
//
// The type is unexported and the value is a struct{} literal, so no package
// outside this one can construct the key — a caller in internal/api cannot
// forge the marker even by accident, and the only way to obtain it is to go
// through CreateFamilyForUser, whose sole caller is an audited tierSysadmin
// route. That is what keeps the closed-alpha guarantee ("no families without
// an invite") intact while still allowing an operator to create one.
type sysadminCreateKey struct{}

// withSysadminCreate returns ctx carrying the marker above.
func withSysadminCreate(ctx context.Context) context.Context {
	return context.WithValue(ctx, sysadminCreateKey{}, true)
}

// hasSysadminCreate reports whether ctx was produced by withSysadminCreate.
func hasSysadminCreate(ctx context.Context) bool {
	authorized, _ := ctx.Value(sysadminCreateKey{}).(bool)
	return authorized
}

// CreateFamily creates the organization and makes userID its first member
// with the admin role.
func (s *service) CreateFamily(ctx context.Context, userID, name string) (string, error) {
	return s.createFamily(ctx, userID, name)
}

// CreateFamilyForUser creates a family whose first admin is ownerUserID, on
// the authority of a system administrator rather than the owner's own.
//
// It exists because allowOrgCreation measures the CREATOR, and
// CreateOrganization's creator is the family's first admin. Under closed
// signup a freshly provisioned account is neither a system admin nor
// family-less-during-the-bootstrap-window, so a plain CreateFamily on its
// behalf fails closed — correctly, for every self-serve path, and uselessly
// for an operator creating a family for a new parent.
//
// The marker travels on the context because that is the only thing
// CreateOrganization threads through to the hook: the hook's signature is
// (ctx, *limen.User), so there is nowhere else to put an actor. See
// sysadminCreateKey for why that cannot be abused from outside this package.
func (s *service) CreateFamilyForUser(ctx context.Context, ownerUserID, name string) (string, error) {
	return s.createFamily(withSysadminCreate(ctx), ownerUserID, name)
}

// CreateEmptyFamily creates a family with NO members at all: the operator
// console's "create a family and hand its invite link to whoever will run
// it" path, where the person who will be its admin has no account yet and
// may never sign in with the address anyone guessed for them.
//
// Limen has no way to express this. CreateOrganization always installs its
// creator as the first member, inside its own transaction, so the only
// route to an empty family is to create one and then remove that
// membership. operatorUserID is therefore a *momentary* member — which is
// exactly why this method exists rather than the caller doing the two steps
// itself. A system administrator quietly left inside a family would have
// standing access to a child's health record through the ordinary app,
// which is the one thing the console is built not to do, so the removal is
// checked and its failure is the whole call's failure.
//
// The removal deliberately does NOT go through RemoveMember: that enforces
// the last-admin guard, and the operator IS the last admin here. Leaving the
// family adminless is the intended outcome — the invite that follows carries
// the admin role, and ListAdminFamilies badges the family until someone
// redeems it.
//
// If the removal fails the family survives with the operator inside it. That
// is visible (the console lists it, with the operator as a member) and
// repairable with one click, which is the least bad of the available
// outcomes: the alternative — deleting the family to clean up — would be a
// compensating delete of exactly the kind the Go port removed.
func (s *service) CreateEmptyFamily(ctx context.Context, operatorUserID, name string) (string, error) {
	familyID, err := s.createFamily(withSysadminCreate(ctx), operatorUserID, name)
	if err != nil {
		return "", err
	}

	if err := s.inTx(ctx, func(q *gen.Queries) error {
		memberID, err := q.GetFamilyMembershipIDForUser(ctx, gen.GetFamilyMembershipIDForUserParams{
			OrganizationID: familyID,
			UserID:         operatorUserID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Already empty. Limen changed its mind about seeding a
				// creator, which is fine and leaves nothing to do.
				return nil
			}
			return fmt.Errorf("auth: load operator membership: %w", err)
		}
		if err := q.ClearActiveFamilyForUser(ctx, gen.ClearActiveFamilyForUserParams{
			ActiveOrganizationID: &familyID,
			UserID:               operatorUserID,
		}); err != nil {
			return fmt.Errorf("auth: clear active family: %w", err)
		}
		if err := q.DeleteFamilyMemberRoles(ctx, gen.DeleteFamilyMemberRolesParams{
			OrganizationID: familyID,
			MemberID:       memberID,
		}); err != nil {
			return fmt.Errorf("auth: delete operator member roles: %w", err)
		}
		if err := q.DeleteFamilyMember(ctx, gen.DeleteFamilyMemberParams{
			OrganizationID: familyID,
			ID:             memberID,
		}); err != nil {
			return fmt.Errorf("auth: delete operator membership: %w", err)
		}
		return nil
	}); err != nil {
		return "", err
	}
	return familyID, nil
}

func (s *service) createFamily(ctx context.Context, userID, name string) (string, error) {
	user, err := s.core.DBAction.FindUserByID(ctx, userID)
	if err != nil {
		return "", fmt.Errorf("auth: load family creator: %w", err)
	}

	// Slug left empty on purpose: the configured slug generator (see New)
	// derives it, so this path and Limen's own create route produce the same
	// shape of slug.
	family, err := s.org.CreateOrganization(ctx, user, &organization.CreateOrganizationRequest{
		Name: name,
	})
	if err != nil {
		return "", fmt.Errorf("auth: create family: %w", err)
	}
	return idString(family.ID), nil
}

// AddMember adds an existing user to a family. Limen's AddMember is the
// permission-free variant on purpose: the caller is already an authorized
// family admin (or the invite-redeem flow), and re-deriving that here would
// mean threading an actor through every call site.
func (s *service) AddMember(ctx context.Context, familyID, userID, role string) error {
	if err := validRole(role); err != nil {
		return err
	}
	if _, err := s.org.AddMember(ctx, familyID, userID, role); err != nil {
		return fmt.Errorf("auth: add member: %w", err)
	}
	return nil
}

// RemoveMember removes a member from a family.
//
// The organization plugin's RemoveMember takes an ACTOR user and checks that
// actor's permissions; our Service is called from handlers that have already
// authorized the caller and does not carry one. Rather than invent an actor,
// the three writes Limen's own deleteMember performs are done directly, in
// one transaction: clear the family off that user's sessions, drop the role
// rows, drop the membership.
//
// The same transaction deletes the person's reminders, snoozes and
// calendar assignments in that family (issue #92). Those rows reference
// the user, not the membership, so nothing cascades — and left behind they
// kept pushing the baby's name and the time since the last feed to someone
// the family had removed, who could not delete them because the reminders
// routes need membership. The frequent job also skips non-members (see
// ListAllReminders); this is the half that leaves nothing to skip.
func (s *service) RemoveMember(ctx context.Context, familyID, memberID string) error {
	return s.inTx(ctx, func(q *gen.Queries) error {
		member, err := q.GetFamilyMember(ctx, gen.GetFamilyMemberParams{
			OrganizationID: familyID,
			ID:             memberID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrMemberNotInFamily
			}
			return fmt.Errorf("auth: load member: %w", err)
		}

		// Removing a non-admin never needs the count query at all — this
		// short-circuits the common case (a parent removing a plain member)
		// without an extra round trip.
		if isPrivilegedRole(member.Role) {
			admins, err := q.CountFamilyAdmins(ctx, familyID)
			if err != nil {
				return fmt.Errorf("auth: count family admins: %w", err)
			}
			if admins <= 1 {
				return ErrLastAdmin
			}
		}

		if err := q.ClearActiveFamilyForUser(ctx, gen.ClearActiveFamilyForUserParams{
			ActiveOrganizationID: &familyID,
			UserID:               member.UserID,
		}); err != nil {
			return fmt.Errorf("auth: clear active family: %w", err)
		}
		if err := q.DeleteMemberReminders(ctx, gen.DeleteMemberRemindersParams{
			FamilyID: familyID,
			UserID:   member.UserID,
		}); err != nil {
			return fmt.Errorf("auth: delete member reminders: %w", err)
		}
		if err := q.DeleteMemberPushSnoozes(ctx, gen.DeleteMemberPushSnoozesParams{
			FamilyID: familyID,
			UserID:   member.UserID,
		}); err != nil {
			return fmt.Errorf("auth: delete member snoozes: %w", err)
		}
		if err := q.DeleteMemberCalendarAssignments(ctx, gen.DeleteMemberCalendarAssignmentsParams{
			FamilyID: familyID,
			UserID:   member.UserID,
		}); err != nil {
			return fmt.Errorf("auth: delete member calendar assignments: %w", err)
		}
		if err := q.DeleteFamilyMemberRoles(ctx, gen.DeleteFamilyMemberRolesParams{
			OrganizationID: familyID,
			MemberID:       memberID,
		}); err != nil {
			return fmt.Errorf("auth: delete member roles: %w", err)
		}
		if err := q.DeleteFamilyMember(ctx, gen.DeleteFamilyMemberParams{
			OrganizationID: familyID,
			ID:             memberID,
		}); err != nil {
			return fmt.Errorf("auth: delete member: %w", err)
		}
		return nil
	})
}

// SetMemberRole replaces a member's roles with exactly one role.
//
// Same reason as RemoveMember for not using the plugin's AssignMemberRole:
// it requires an actor and its permission check. A member holds exactly one
// role in Pjokk, so "set" is delete-then-insert rather than the plugin's
// assign/revoke pair.
func (s *service) SetMemberRole(ctx context.Context, familyID, memberID, role string) error {
	if err := validRole(role); err != nil {
		return err
	}
	return s.inTx(ctx, func(q *gen.Queries) error {
		member, err := q.GetFamilyMember(ctx, gen.GetFamilyMemberParams{
			OrganizationID: familyID,
			ID:             memberID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrMemberNotInFamily
			}
			return fmt.Errorf("auth: load member: %w", err)
		}

		// Only a change AWAY from admin is a demotion — re-setting an
		// existing admin to "admin", or promoting a plain member, never
		// shrinks the admin count, so neither needs the guard.
		if isPrivilegedRole(member.Role) && role != RoleAdmin {
			admins, err := q.CountFamilyAdmins(ctx, familyID)
			if err != nil {
				return fmt.Errorf("auth: count family admins: %w", err)
			}
			if admins <= 1 {
				return ErrLastAdmin
			}
		}

		if err := q.DeleteFamilyMemberRoles(ctx, gen.DeleteFamilyMemberRolesParams{
			OrganizationID: familyID,
			MemberID:       memberID,
		}); err != nil {
			return fmt.Errorf("auth: clear member roles: %w", err)
		}
		if err := q.InsertFamilyMemberRole(ctx, gen.InsertFamilyMemberRoleParams{
			MemberID:       memberID,
			OrganizationID: familyID,
			Role:           &role,
		}); err != nil {
			return fmt.Errorf("auth: set member role: %w", err)
		}
		return nil
	})
}

// SetActiveFamily points a session at a family; an empty familyID clears it.
//
// It checks membership FIRST. Limen's SetActiveOrganization is the unchecked
// variant — it writes the column and nothing else — and its checked sibling
// SwitchOrganization derives the user from session.UserID, which a
// token-only call does not have. Since the tenancy middleware trusts
// active_organization_id as the family scope for every subsequent query,
// writing it without a membership check would let any signed-in user read
// any family's data by naming its id. The guard is the whole point of this
// method existing rather than exposing Limen's route.
//
// The organization plugin returns a *limen.SessionResult because a
// client-visible session backend (JWT) would have to re-issue the token. Ours
// is the database store, which updates the row in place and returns nil, so
// there is nothing to deliver back to the client — which is why this method
// can take a bare token rather than a ResponseWriter.
func (s *service) SetActiveFamily(ctx context.Context, sessionToken, familyID string) error {
	session := &limen.Session{Token: sessionToken}

	if familyID == "" {
		if _, err := s.org.SetActiveOrganization(ctx, session, nil); err != nil {
			return fmt.Errorf("auth: clear active family: %w", err)
		}
		return nil
	}

	record, err := s.q.GetSessionRecord(ctx, sessionToken)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSessionNotFound
		}
		return fmt.Errorf("auth: load session: %w", err)
	}

	members, err := s.q.CountFamilyMembership(ctx, gen.CountFamilyMembershipParams{
		OrganizationID: familyID,
		UserID:         record.UserID,
	})
	if err != nil {
		return fmt.Errorf("auth: check family membership: %w", err)
	}
	if members == 0 {
		return fmt.Errorf("%w: %s", ErrNotFamilyMember, familyID)
	}

	family, err := s.org.GetOrganization(ctx, familyID)
	if err != nil {
		return fmt.Errorf("auth: load family: %w", err)
	}
	if _, err := s.org.SetActiveOrganization(ctx, session, family); err != nil {
		return fmt.Errorf("auth: set active family: %w", err)
	}
	return nil
}

func validRole(role string) error {
	switch role {
	case RoleAdmin, RoleMember:
		return nil
	default:
		return fmt.Errorf("%w: %q", ErrUnknownRole, role)
	}
}

// familySlug builds the organization slug. Limen requires it to be unique
// across every organization, and family names repeat constantly ("Hansen"),
// so a random suffix is appended rather than letting the second Hansen family
// fail to be created.
func familySlug(name string) string {
	var b strings.Builder
	previousDash := true // leading dashes are suppressed
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			previousDash = false
		case !previousDash:
			b.WriteByte('-')
			previousDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = "family"
	}
	return slug + "-" + randomHex(4)
}
