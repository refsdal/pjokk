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
	validated, err := s.limen.GetSession(r)
	if err != nil {
		if isSignedOut(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("auth: validate session: %w", err)
	}
	if validated == nil || validated.User == nil || validated.Session == nil {
		return nil, nil
	}

	row, err := s.q.GetAuthSession(r.Context(), gen.GetAuthSessionParams{
		Token:  validated.Session.Token,
		UserID: idString(validated.User.ID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("auth: load session context: %w", err)
	}
	if row.Banned {
		return nil, nil
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
	return session, nil
}

// isSignedOut reports whether err means "no valid session" rather than "the
// database is on fire". Matching sentinels keeps a real failure from being
// silently rendered as a signed-out page.
func isSignedOut(err error) bool {
	return errors.Is(err, limen.ErrSessionNotFound) ||
		errors.Is(err, limen.ErrSessionExpired) ||
		errors.Is(err, limen.ErrRecordNotFound)
}
