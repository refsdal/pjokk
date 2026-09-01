package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/thecodearcher/limen"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// pjokkPluginName identifies our one custom Limen plugin. It must not collide
// with a plugin Limen or its official plugins register.
const pjokkPluginName limen.PluginName = "pjokk-core"

// metaImpersonatedBy marks an impersonated session in its JSON metadata.
//
// ONLY the admin's user id lives here, never their session token. Limen's
// own ListSessions hands a session's Token and Metadata back to the session
// owner, so anything in metadata must be safe for the impersonated user to
// read; a user id is (they see the banner naming the admin anyway), a live
// admin session token is a straight privilege escalation. The token lives in
// the server-only `impersonation` table instead — see 00003_impersonation.sql
// — and the ListSessions route is disabled on top of that.
const metaImpersonatedBy = "impersonated_by"

// corePlugin exists for one reason: *limen.LimenCore is not reachable from
// the *limen.Limen handle that limen.New returns, but every plugin is handed
// the core in Initialize. Registering a plugin that does nothing except keep
// the pointer is the supported way to reach core.CreateSession,
// core.DBAction and core.Cookies — the three things impersonation needs and
// the public Limen surface does not expose.
//
// It registers no routes and no schemas.
type corePlugin struct {
	core *limen.LimenCore
}

func (p *corePlugin) Name() limen.PluginName { return pjokkPluginName }

func (p *corePlugin) Initialize(core *limen.LimenCore) error {
	if core == nil {
		return errors.New("auth: limen initialized the plugin with a nil core")
	}
	p.core = core
	return nil
}

func (p *corePlugin) PluginHTTPConfig() limen.PluginHTTPConfig {
	return limen.PluginHTTPConfig{}
}

func (p *corePlugin) RegisterRoutes(*limen.LimenHTTPCore, *limen.RouteBuilder) {}

// Impersonate signs the caller in as targetUserID: it mints a second session
// for the target user, records who is really driving it, and swaps the
// response cookie over to it.
//
// The record is split on purpose. The admin's USER ID goes into the
// impersonated session's metadata, where SessionFromRequest reads it for the
// banner. The admin's SESSION TOKEN goes into the server-only
// `impersonation` table, which nothing outside this package reads — see
// 00003_impersonation.sql for what happens when it does not.
//
// The admin's session is deliberately NOT revoked — StopImpersonating puts
// its token straight back into the cookie, so an interrupted impersonation
// (browser closed, tab crashed) costs the admin nothing but a re-login on
// the impersonated tab.
func (s *service) Impersonate(ctx context.Context, w http.ResponseWriter, r *http.Request, adminSession *Session, targetUserID string) error {
	switch {
	case adminSession == nil:
		return errors.New("auth: impersonate requires a signed-in admin session")
	case adminSession.Role != RoleSystemAdmin:
		return ErrNotSystemAdmin
	case adminSession.ImpersonatedBy != "":
		return errors.New("auth: cannot impersonate from an impersonated session")
	case targetUserID == "":
		return errors.New("auth: impersonate requires a target user")
	case targetUserID == adminSession.UserID:
		return errors.New("auth: cannot impersonate yourself")
	}

	target, err := s.core.DBAction.FindUserByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("auth: load impersonation target: %w", err)
	}

	result, err := s.core.CreateSession(ctx, r, w, &limen.AuthenticationResult{User: target})
	if err != nil {
		return fmt.Errorf("auth: create impersonated session: %w", err)
	}

	// Merge rather than replace: CreateSession already stored the session's
	// own metadata (address digest, user agent) and dropping it would lose
	// the audit value of the impersonated session itself.
	metadata, err := s.sessionMetadata(ctx, result.Token)
	if err == nil {
		metadata[metaImpersonatedBy] = adminSession.UserID
		err = s.writeSessionMetadata(ctx, result.Token, metadata)
	}
	if err == nil {
		err = s.q.CreateImpersonation(ctx, gen.CreateImpersonationParams{
			ImpersonatedToken: result.Token,
			AdminToken:        adminSession.Token,
			AdminID:           adminSession.UserID,
		})
		if err != nil {
			err = fmt.Errorf("auth: record impersonation: %w", err)
		}
	}
	if err != nil {
		// A half-recorded impersonation is worse than none: the session
		// exists and would be indistinguishable from the target signing in
		// themselves, or unstoppable because nothing knows how to get back.
		// Revoke it (which cascades the impersonation row away) and fail.
		_ = s.limen.RevokeSession(ctx, result.Token)
		return err
	}

	if err := s.core.Cookies().SetSessionCookie(w, result); err != nil {
		_ = s.limen.RevokeSession(ctx, result.Token)
		return fmt.Errorf("auth: set impersonated session cookie: %w", err)
	}
	return nil
}

// StopImpersonating reverses Impersonate: it restores the admin's own session
// cookie from the server-only record written at impersonation time, then
// revokes the impersonated session so the token cannot be replayed.
//
// The admin token is read from the `impersonation` table, never from the
// caller-supplied Session, so this cannot be talked into restoring a session
// the caller merely claims to own.
//
// EVERY exit is terminal: whatever went wrong, the operator must not be left
// holding a live session as the target. If the admin session cannot be
// restored (revoked, expired, the record is gone), the impersonated session
// is revoked and its cookie cleared anyway, and the error explains that they
// need to sign in again. Failing "safely" by leaving the impersonation
// running is the one outcome that is not acceptable.
func (s *service) StopImpersonating(ctx context.Context, w http.ResponseWriter, _ *http.Request, session *Session) error {
	if session == nil || session.ImpersonatedBy == "" {
		return ErrNotImpersonating
	}

	record, err := s.q.GetImpersonation(ctx, session.Token)
	if err != nil {
		return s.endImpersonation(ctx, w, session.Token,
			fmt.Errorf("auth: no impersonation record for this session, signed out instead: %w", err))
	}

	admin, err := s.q.GetSessionRecord(ctx, record.AdminToken)
	if err != nil {
		return s.endImpersonation(ctx, w, session.Token,
			fmt.Errorf("auth: the admin session to restore is gone, signed out instead: %w", err))
	}

	maxAge := int(time.Until(admin.ExpiresAt.Time).Seconds())
	if maxAge <= 0 {
		return s.endImpersonation(ctx, w, session.Token,
			errors.New("auth: the admin session to restore has expired, signed out instead"))
	}

	s.core.Cookies().Set(w, sessionCookieName, record.AdminToken, maxAge)

	// Revoking the impersonated session cascades its impersonation row away
	// (00003), so there is nothing else to clean up.
	if err := s.limen.RevokeSession(ctx, session.Token); err != nil {
		return fmt.Errorf("auth: revoke impersonated session: %w", err)
	}
	return nil
}

// endImpersonation is the terminal fallback: revoke the impersonated session
// and clear the cookie, then report why the admin's own session could not be
// restored. The caller is signed out rather than left as the target.
func (s *service) endImpersonation(ctx context.Context, w http.ResponseWriter, token string, cause error) error {
	_ = s.q.DeleteImpersonation(ctx, token)
	_ = s.limen.RevokeSession(ctx, token)
	s.core.Cookies().DeleteSessionCookie(w)
	return cause
}

// sessionMetadata reads a session's metadata blob. Limen stores it as JSON in
// a text column (SessionSchema.ToStorage marshals it), so an empty or absent
// value is a legitimate "no metadata yet", not an error.
func (s *service) sessionMetadata(ctx context.Context, token string) (map[string]any, error) {
	record, err := s.q.GetSessionRecord(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("auth: read session metadata: %w", err)
	}
	metadata := map[string]any{}
	if record.Metadata == "" {
		return metadata, nil
	}
	if err := json.Unmarshal([]byte(record.Metadata), &metadata); err != nil {
		return nil, fmt.Errorf("auth: decode session metadata: %w", err)
	}
	return metadata, nil
}

// writeSessionMetadata persists metadata through Limen's session manager
// rather than with an UPDATE of our own, so the write goes through whatever
// session store is configured (database today) and stays consistent with the
// in-memory session Limen may be holding.
func (s *service) writeSessionMetadata(ctx context.Context, token string, metadata map[string]any) error {
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("auth: encode session metadata: %w", err)
	}
	if _, err := s.core.SessionManager.UpdateSession(ctx, &limen.Session{Token: token}, map[limen.SchemaField]any{
		limen.SessionSchemaMetadataField: string(encoded),
	}); err != nil {
		return fmt.Errorf("auth: write session metadata: %w", err)
	}
	return nil
}

var _ limen.Plugin = (*corePlugin)(nil)
