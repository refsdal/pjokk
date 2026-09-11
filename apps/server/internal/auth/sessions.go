package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// One person's sessions and login address, for the operator console's user
// page (docs/superpowers/specs/2026-09-11-admin-user-support-design.md §3).
// They live here rather than in internal/api because they read and write
// Limen's tables — the seam CLAUDE.md keeps Limen behind.

// SessionInfo is one live session as the console may see it. Deliberately
// no token and no raw metadata: the metadata holds the session's (keyed)
// address digest, and the console never shows an address in any form.
type SessionInfo struct {
	ID        string
	UserAgent string // "" when the browser sent none
	CreatedAt time.Time
	// LastActiveAt is last_access, or CreatedAt before any recorded
	// activity. Limen writes it at most every five minutes (auth.New's
	// activity interval).
	LastActiveAt   time.Time
	ExpiresAt      time.Time
	ActiveFamilyID string // "" when none
	FamilyName     string // "" when none
	// ImpersonatedBy is the operator's user id when a system admin is
	// driving this session, "" for the person's own.
	ImpersonatedBy string
}

// metaUserAgent is where Limen's session manager records the browser
// (session_manager.go's metadata map, beside the address digest).
const metaUserAgent = "user_agent"

// UserSessions lists userID's live sessions, most recently active first.
func (s *service) UserSessions(ctx context.Context, userID string) ([]SessionInfo, error) {
	rows, err := s.q.ListUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("auth: list sessions: %w", err)
	}
	out := make([]SessionInfo, 0, len(rows))
	for _, row := range rows {
		info := SessionInfo{
			ID:             row.ID,
			CreatedAt:      row.CreatedAt.Time,
			LastActiveAt:   row.CreatedAt.Time,
			ExpiresAt:      row.ExpiresAt.Time,
			ActiveFamilyID: row.ActiveFamilyID,
			FamilyName:     row.FamilyName,
		}
		if row.LastAccess.Valid {
			info.LastActiveAt = row.LastAccess.Time
		}
		// Only two keys are read out of the blob. One that will not decode
		// costs the description, never the row: the operator can still see
		// the session exists and sign it out.
		metadata := map[string]any{}
		if row.Metadata != "" && json.Unmarshal([]byte(row.Metadata), &metadata) == nil {
			info.UserAgent, _ = metadata[metaUserAgent].(string)
			info.ImpersonatedBy, _ = metadata[metaImpersonatedBy].(string)
		}
		out = append(out, info)
	}
	return out, nil
}

// RevokeSession signs out one of userID's sessions. A session id that is
// not theirs is ErrSessionNotFound, exactly like one that does not exist.
func (s *service) RevokeSession(ctx context.Context, userID, sessionID string) error {
	token, err := s.q.GetUserSessionToken(ctx, gen.GetUserSessionTokenParams{ID: sessionID, UserID: userID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return ErrSessionNotFound
	case err != nil:
		return fmt.Errorf("auth: find session: %w", err)
	}
	// Through Limen, so its session store stays consistent with the table.
	// An impersonated session's `impersonation` row cascades away with it
	// (00003_impersonation.sql).
	if err := s.limen.RevokeSession(ctx, token); err != nil {
		return fmt.Errorf("auth: revoke session: %w", err)
	}
	return nil
}

// ChangeEmail replaces userID's login address. Sessions and linked OAuth
// accounts are untouched: a Google account is linked by its own id, not by
// the address, so Google sign-in keeps working, and password sign-in uses
// the new address from here on.
func (s *service) ChangeEmail(ctx context.Context, userID, email string) error {
	if err := s.q.ChangeUserEmail(ctx, gen.ChangeUserEmailParams{ID: userID, Email: NormalizeEmail(email)}); err != nil {
		if db.IsUniqueViolation(err) {
			return ErrEmailTaken
		}
		return fmt.Errorf("auth: change email: %w", err)
	}
	return nil
}
