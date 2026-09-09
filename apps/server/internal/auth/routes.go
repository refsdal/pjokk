package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

// This file is package auth's HTTP surface: which of Limen's routes are
// mounted at all, and the guard every mounted one runs behind.
//
// The allowlist is the point. Registering the credential-password, oauth and
// organization plugins mounts ~40 routes, most of which duplicate or
// contradict Pjokk's own API, so the set below is opt-IN — see
// allowedRouteIDs for what is kept and why each of the rest is not, and
// knownRouteIDs for why the list is hand-maintained.

// knownRouteIDs is every route the registered Limen plugins can mount, as of
// the pinned versions. It exists so the HTTP surface can be expressed as an
// ALLOWLIST: Limen registers a large, capable API by default, most of which
// duplicates or contradicts Pjokk's own — and every route we do not turn off
// is a route we have implicitly accepted responsibility for.
//
// This list must be revisited whenever a Limen module is upgraded: a route
// added upstream and not named here would be silently enabled. The route
// tests below exist to make that concrete rather than aspirational.
var knownRouteIDs = []string{
	// core (limen_handlers.go)
	"me", "list-sessions", "signout", "revoke-sessions",
	"verify-email", "email-verifications",
	// credential-password
	"signin", "signup",
	"passwords-request-reset", "passwords-reset", "passwords-change",
	"passwords-set", "usernames-check",
	// oauth
	"oauth-authorize", "oauth-callback", "oauth-callback-post",
	"oauth-link-authorize", "oauth-list-accounts", "oauth-unlink-account",
	"oauth-get-tokens", "oauth-refresh-tokens",
	// organization
	"organizations:create", "organizations:list", "organizations:check-slug",
	"organizations:update", "organizations:delete",
	"organizations:members-list", "organizations:member-get",
	"organizations:get-active", "organizations:switch",
	"organizations:leave-organization",
	"organizations:invite-member", "organizations:respond-to-invitation",
	"organizations:get-invitation-by-token",
	"organizations:cancel-pending-invitation", "organizations:list-invitations",
	"organizations:revoke-member-role", "organizations:assign-member-role",
	"organizations:remove-member",
	"organizations:create-role", "organizations:list-roles",
	"organizations:update-role", "organizations:delete-role",
}

// allowedRouteIDs is the only part of Limen's HTTP surface the SPA reaches.
// Everything else is turned off, for these reasons:
//
//   - list-sessions / revoke-sessions: ListSessions serialises a session's
//     Token AND Metadata back to its owner. Nothing in Pjokk needs a device
//     list, and handing a session's own token back to it is exactly the
//     shape of bug that made 00003 necessary.
//   - ALL invitation routes: Limen's invitations are email-addressed, which
//     is the wrong grain for a QR code at Sunday dinner. The real invite
//     mechanism is our own family_invite table (CLAUDE.md); a second,
//     unaudited join path into a family is a tenancy hole waiting to happen.
//   - member list/remove/role assign/revoke, organization update/delete,
//     leave: family and member management goes through our own API, which
//     applies our roles, our entitlement gates, and our audit trail.
//   - passwords-*: email/password is the dev/demo sign-IN path only; no
//     mailer is configured, so a reset flow could only half-work.
//   - usernames-check, oauth account link/unlink/tokens: features we do not
//     ship.
//   - verify-email / email-verifications: same, no mailer.
//
// Kept: credential sign-in, Google authorize + callback, signout, the
// session read, and the four organization routes the SPA uses: create,
// list, switch, and the member-self read (GET /organizations/me) that the
// limen-auth client fires in the background after create/switch to refresh
// its own store — disabled it produced a harmless-but-noisy swallowed 404.
// It returns only the caller's own membership. Signup is kept only when
// signup is open.
func allowedRouteIDs(openSignup bool) []string {
	allowed := []string{
		"signin",
		"signout",
		"me",
		"oauth-authorize",
		"oauth-callback",
		"oauth-callback-post",
		"organizations:create",
		"organizations:list",
		"organizations:switch",
		"organizations:member-get",
	}
	if openSignup {
		allowed = append(allowed, "signup")
	}
	return allowed
}

// disabledRouteIDs is the allowlist's complement. Limen matches these against
// a route's ID (or its path), and a disabled route is never registered at
// all: requests fall through to the router's not-found handler.
func disabledRouteIDs(openSignup bool) []string {
	allowed := make(map[string]struct{}, len(allowedRouteIDs(openSignup)))
	for _, id := range allowedRouteIDs(openSignup) {
		allowed[id] = struct{}{}
	}

	disabled := make([]string, 0, len(knownRouteIDs))
	for _, id := range knownRouteIDs {
		if _, ok := allowed[id]; !ok {
			disabled = append(disabled, id)
		}
	}
	return disabled
}

// Handler returns Limen's router behind the banned guard.
//
// SessionFromRequest already reports a banned user as signed out, which
// covers our own routes — but Limen's routes never ask us. Without this, a
// banned account could still read /api/auth/me, list its organizations, or
// switch families with a cookie issued before the ban. Signing out is the
// one thing it is still allowed to do.
func (s *service) Handler() http.Handler {
	return s.bannedGuard(s.limen.Handler())
}

// bannedGuard rejects requests carrying a session whose user is banned.
//
// It reads the token straight off the request and asks the database once,
// rather than calling GetSession: session validation has side effects (it
// can extend a session's expiry), and this guard runs ahead of Limen's own
// validation on every auth route.
//
// A request with no token, or a token with no row, is left alone — Limen's
// own handlers decide what an anonymous or stale request means. A database
// failure denies the request rather than falling open.
func (s *service) bannedGuard(next http.Handler) http.Handler {
	signoutPath := BasePath + "/signout"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == signoutPath {
			next.ServeHTTP(w, r)
			return
		}

		token := sessionToken(r)
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}

		banned, err := s.q.IsSessionUserBanned(r.Context(), token)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			next.ServeHTTP(w, r)
			return
		case err != nil:
			writeAuthError(w, http.StatusInternalServerError, "session lookup failed")
			return
		case banned:
			writeAuthError(w, http.StatusUnauthorized, "account suspended")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// sessionToken mirrors Limen's own token extraction: cookie first, then a
// bearer header (which the bearer plugin accepts for a future native shell).
func sessionToken(r *http.Request) string {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		if token := strings.TrimSpace(cookie.Value); token != "" {
			return token
		}
	}
	scheme, token, found := strings.Cut(r.Header.Get("Authorization"), " ")
	if found && strings.EqualFold(scheme, "bearer") {
		return strings.TrimSpace(token)
	}
	return ""
}

// writeAuthError matches the shape Limen's own Responder emits ({"message":
// …}), so a client cannot tell our guard from a Limen rejection and needs no
// special case for it.
func writeAuthError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"message": message})
}
