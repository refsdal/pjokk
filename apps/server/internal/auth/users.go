package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/thecodearcher/limen"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file is package auth's account surface: creating users, setting
// passwords, and revoking sessions.

// CreateUser creates an account, optionally without a usable password.
//
// An empty password stores NULL in users.password rather than a hash of some
// random string. That is the difference between "a credential nobody knows"
// and "no credential": Limen's credential plugin reads a NULL password as
// "signed up through OAuth", which makes sign-in fail cleanly AND lets
// SetPassword later establish a first password (it refuses to overwrite an
// existing one). A random throwaway hash would have locked the account out
// of its own recovery path.
//
// The passwordless branch therefore goes through Limen's low-level user
// creation instead of the credential plugin's signup, which dereferences the
// password before it does anything else.
func (s *service) CreateUser(ctx context.Context, name, email, password string) (string, error) {
	email = limen.NormalizeEmail(email)

	if password == "" {
		return s.createUserWithoutCredential(ctx, name, email)
	}

	result, err := s.cred.SignUpWithCredentialAndPassword(ctx, &limen.User{
		Email:    email,
		Password: &password,
	}, map[string]any{"name": name})
	if err != nil {
		return "", fmt.Errorf("auth: create user: %w", err)
	}
	return idString(result.User.ID), nil
}

func (s *service) createUserWithoutCredential(ctx context.Context, name, email string) (string, error) {
	switch _, err := s.core.DBAction.FindUserByEmail(ctx, email); {
	case err == nil:
		return "", fmt.Errorf("%w: %s", ErrEmailTaken, email)
	case !errors.Is(err, limen.ErrRecordNotFound):
		return "", fmt.Errorf("auth: look up existing user: %w", err)
	}

	// No password field: the column stays NULL.
	if err := s.core.DBAction.CreateUser(ctx, &limen.User{Email: email}, map[string]any{"name": name}); err != nil {
		return "", fmt.Errorf("auth: create user: %w", err)
	}

	// Limen's low-level create does not return the row; the email is unique,
	// so reading it back is unambiguous.
	created, err := s.core.DBAction.FindUserByEmail(ctx, email)
	if err != nil {
		return "", fmt.Errorf("auth: read back created user: %w", err)
	}
	return idString(created.ID), nil
}

// SetPassword sets a user's password, whatever they had before — an OAuth
// or invite-provisioned account with none, or a forgotten one — and revokes
// their sessions: an administrator changing someone's password is either a
// recovery or a response to a compromise, and both want the old sessions
// gone.
//
// It does NOT take the current password, on purpose: the caller is an
// operator acting on someone else's account (the console's
// POST /api/admin/users/{id}/password), not the account's owner. Guarding
// this is the API layer's job — it sits behind RequireSysadmin and audits
// every call.
//
// Two paths, because Limen's credential plugin has no single method for
// this. Its SetPassword establishes a FIRST password only
// (ErrPasswordAlreadySet otherwise) and its UpdatePassword demands the
// current one. So an account with no password goes through Limen (keeping
// its own validation and session revocation), and an account that already
// has one gets Limen's hasher plus our own UPDATE — the hash is Limen's
// either way, so the stored value is exactly what its sign-in comparison
// expects; only who issues the UPDATE differs.
func (s *service) SetPassword(ctx context.Context, userID, newPassword string) error {
	// Validated in ONE place, ahead of both branches. Limen enforces its
	// policy inside its own SetPassword and would reject a weak password
	// there — but the reset branch below never reaches that code, so
	// without this the two branches would accept different passwords and a
	// spec-valid lowercase one would 500 on the first branch and succeed on
	// the second.
	if err := validatePassword(newPassword); err != nil {
		return err
	}

	user, err := s.core.DBAction.FindUserByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("auth: load user: %w", err)
	}

	// An empty string is treated as "no password", not as a password of
	// length zero: CreateUser's passwordless branch stores NULL, but a row
	// written by anything else (a migration, an import) could hold '' with
	// the same meaning, and Limen's own SetPassword accepts both (its
	// UPDATE guard is `password IS NULL OR password = ''`).
	if user.Password == nil || *user.Password == "" {
		if err := s.cred.SetPassword(ctx, user, newPassword, true); err != nil {
			return fmt.Errorf("auth: set password: %w", err)
		}
		return nil
	}

	hashed, err := s.cred.HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("auth: hash password: %w", err)
	}
	if err := s.q.SetUserPassword(ctx, gen.SetUserPasswordParams{ID: userID, Password: &hashed}); err != nil {
		return fmt.Errorf("auth: store password: %w", err)
	}
	// Same effect as the revokeOtherSessions:true the branch above asks
	// Limen for: a reset must not leave a compromised session alive.
	//
	// Not in one transaction with the UPDATE, and it cannot be: revocation
	// goes through Limen's session manager, which owns its own handle and
	// takes no transaction from us (the first branch has the same split —
	// Limen's SetPassword opens its OWN transaction around both). The order
	// is the safe one: if the revoke fails after the UPDATE, the caller
	// gets an error while the old password has already stopped working. The
	// reverse order would report failure with the old password still live.
	return s.RevokeAllSessions(ctx, userID)
}

// Password policy, mirroring what credentialpassword.New() configures in
// New above — it is constructed with no ConfigOptions, so these ARE its
// defaults (constants.go in the plugin: min length 8, uppercase required,
// numbers required, symbols not required). If New ever passes
// WithPasswordMinLength/WithPasswordRequire*, change these to match, or
// SetPassword and Limen's own sign-up will disagree about what is
// acceptable.
const (
	passwordMinLength = 8
	passwordUppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	passwordDigits    = "0123456789"
)

// PasswordPolicyError says a password was rejected before it was stored,
// and which requirement it failed. Callers map it to a 400 rather than a
// 500 — it is the user's input that is wrong, not the server.
//
// Requirement is phrased to follow the word "Password", so an HTTP layer
// can render "Password " + Requirement without restating anything.
type PasswordPolicyError struct {
	Requirement string
}

func (e *PasswordPolicyError) Error() string {
	return "auth: password " + e.Requirement
}

// validatePassword enforces the policy above. It runs before ANY write, in
// both of SetPassword's branches.
func validatePassword(password string) error {
	switch {
	case len(password) < passwordMinLength:
		return &PasswordPolicyError{Requirement: fmt.Sprintf("must be at least %d characters", passwordMinLength)}
	case !strings.ContainsAny(password, passwordUppercase):
		return &PasswordPolicyError{Requirement: "must contain an uppercase letter"}
	case !strings.ContainsAny(password, passwordDigits):
		return &PasswordPolicyError{Requirement: "must contain a number"}
	default:
		return nil
	}
}

// RevokeAllSessions signs a user out everywhere.
//
// "Everywhere" is scoped to sessions whose user_id is theirs, which is what
// Limen knows about — see RevokeImpersonatedSessions for the other half.
func (s *service) RevokeAllSessions(ctx context.Context, userID string) error {
	if err := s.limen.RevokeAllSessions(ctx, userID); err != nil {
		return fmt.Errorf("auth: revoke sessions: %w", err)
	}
	return nil
}

// RevokeImpersonatedSessions revokes every session adminUserID is driving
// through impersonation (see the interface's doc comment for why this is
// separate from RevokeAllSessions).
//
// Revoking the session cascades its `impersonation` row away (00003), so
// the list shrinks as it is walked and nothing else needs tidying.
func (s *service) RevokeImpersonatedSessions(ctx context.Context, adminUserID string) error {
	tokens, err := s.q.ListImpersonatedTokensByAdmin(ctx, adminUserID)
	if err != nil {
		return fmt.Errorf("auth: list impersonated sessions: %w", err)
	}
	for _, token := range tokens {
		if err := s.limen.RevokeSession(ctx, token); err != nil {
			return fmt.Errorf("auth: revoke impersonated session: %w", err)
		}
	}
	return nil
}
