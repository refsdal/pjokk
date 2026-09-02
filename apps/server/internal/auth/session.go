package auth

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/thecodearcher/limen"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// SessionFromRequest resolves the caller.
//
// Two steps, deliberately: Limen validates the cookie or bearer token (and
// only Limen can, the token format is its business), then ONE query against
// our own users and sessions columns supplies everything the app branches on.
// Reading name/role/banned/active family from Limen's structs instead would
// couple every caller to whichever additional-field mechanism Limen happens
// to expose this version.
//
// Returns (nil, nil) — not an error — for every flavour of "nobody is signed
// in": no cookie, an expired session, a token whose row has been revoked, and
// a banned user. A banned account is treated exactly like a signed-out one so
// no caller has to remember to check the flag.
func (s *service) SessionFromRequest(r *http.Request) (*Session, error) {
	session, _, err := s.resolveSession(r)
	return session, err
}

// SessionFromRequestRefreshing resolves the caller exactly like
// SessionFromRequest, and additionally re-issues the session cookie when
// Limen extended the session's lifetime while validating it.
//
// Limen's sessions are sliding: validation extends a session whose expiry is
// within UpdateAge (1 day of a 7-day life) and hands back a refreshed
// SessionResult carrying a cookie with the new Max-Age. Limen's own
// MiddlewareRequireSession writes that cookie; nothing else does. Pjokk does
// not use that middleware — the session gate is ours, so it can populate our
// context and never reject — which means without this method the extension
// lands in the database and never reaches the browser, and the cookie
// expires under a user who has been active the whole time.
//
// SessionFromRequest is kept for the callers that genuinely have no writer
// (jobs, the banned guard's siblings); every HTTP request should come through
// here. Limen types stay behind this package's boundary: the refreshed
// SessionResult never leaves.
func (s *service) SessionFromRequestRefreshing(w http.ResponseWriter, r *http.Request) (*Session, error) {
	session, refreshed, err := s.resolveSession(r)
	if err != nil || session == nil || refreshed == nil {
		return session, err
	}
	if err := s.core.Cookies().SetSessionCookie(w, refreshed); err != nil {
		return nil, fmt.Errorf("auth: write refreshed session cookie: %w", err)
	}
	return session, nil
}

// resolveSession is the shared body of the two methods above. The second
// return value is Limen's refreshed session (nil unless validation extended
// the session), which only SessionFromRequestRefreshing acts on.
func (s *service) resolveSession(r *http.Request) (*Session, *limen.SessionResult, error) {
	validated, err := s.limen.GetSession(r)
	if err != nil {
		if isSignedOut(err) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("auth: validate session: %w", err)
	}
	if validated == nil || validated.User == nil || validated.Session == nil {
		return nil, nil, nil
	}

	row, err := s.q.GetAuthSession(r.Context(), gen.GetAuthSessionParams{
		Token:  validated.Session.Token,
		UserID: idString(validated.User.ID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("auth: load session context: %w", err)
	}
	if row.Banned {
		return nil, nil, nil
	}

	session := &Session{
		UserID:         row.UserID,
		Name:           row.Name,
		Email:          row.Email,
		Role:           row.Role,
		Banned:         false,
		ActiveFamilyID: row.ActiveFamilyID,
		Token:          validated.Session.Token,
	}
	if by, ok := validated.Session.Metadata[metaImpersonatedBy].(string); ok {
		session.ImpersonatedBy = by
	}

	// An impersonated session is only as valid as the OPERATOR behind it.
	// Its user_id is the TARGET's, so revoking the operator's sessions —
	// banning them, signing them out, deleting the account — does not touch
	// this row unless something also walks the `impersonation` table
	// (Service.RevokeImpersonatedSessions does, and every caller that cuts
	// an operator off calls it). This is the backstop for the case where
	// one does not: an operator who is banned or gone cannot keep acting as
	// somebody else, whatever state the impersonation table is in.
	//
	// Reported as "signed out" rather than an error, exactly like a banned
	// user above: no caller has to remember to check.
	if session.ImpersonatedBy != "" {
		banned, err := s.q.IsUserBanned(r.Context(), session.ImpersonatedBy)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return nil, nil, nil
		case err != nil:
			return nil, nil, fmt.Errorf("auth: load impersonating admin: %w", err)
		case banned:
			return nil, nil, nil
		}
	}

	// Auto-activate a family for a session that has none. A returning user's
	// fresh sign-in creates a session with no active organization (only
	// family creation, switching, or invite-redeem sets one), so without
	// this every returning member would be resolved as family-less and the
	// SPA would strand them on /welcome — asked to create a family they
	// already belong to. Pick their most recently-joined family; multi-family
	// users can still switch. Never for an impersonated session (its active
	// family is the operator's deliberate choice) and best-effort: a failure
	// here just leaves the session family-less, exactly as before.
	if session.ActiveFamilyID == "" && session.ImpersonatedBy == "" {
		familyID, err := s.q.MostRecentMembership(r.Context(), session.UserID)
		if err == nil && familyID != "" {
			if err := s.q.SetSessionActiveOrg(r.Context(), gen.SetSessionActiveOrgParams{
				Token: session.Token, ActiveOrganizationID: &familyID,
			}); err == nil {
				session.ActiveFamilyID = familyID
			}
		}
	}

	return session, validated.Refreshed, nil
}

// isSignedOut reports whether err means "no valid session" rather than "the
// database is on fire". Matching sentinels keeps a real failure from being
// silently rendered as a signed-out page.
func isSignedOut(err error) bool {
	return errors.Is(err, limen.ErrSessionNotFound) ||
		errors.Is(err, limen.ErrSessionExpired) ||
		errors.Is(err, limen.ErrRecordNotFound)
}
