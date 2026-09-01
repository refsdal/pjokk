package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/thecodearcher/limen"
)

// pjokkPluginName identifies our one custom Limen plugin. It must not collide
// with a plugin Limen or its official plugins register.
const pjokkPluginName limen.PluginName = "pjokk-core"

// Metadata keys written onto an impersonated session. They live in the
// session row's JSON metadata column, which is exactly where an
// impersonation marker belongs: it dies with the session, and it cannot be
// forged by a client because the column is server-side only.
const (
	metaImpersonatedBy = "impersonated_by"
	metaAdminToken     = "admin_token"
)

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
// for the target user, stamps it with who is really driving it and with the
// admin's own session token, and swaps the response cookie over to it.
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
	// own metadata (hashed IP, user agent) and dropping it would lose the
	// audit value of the impersonated session itself.
	metadata, err := s.sessionMetadata(ctx, result.Token)
	if err == nil {
		metadata[metaImpersonatedBy] = adminSession.UserID
		metadata[metaAdminToken] = adminSession.Token
		err = s.writeSessionMetadata(ctx, result.Token, metadata)
	}
	if err != nil {
		// The session exists but carries no marker, which would make it
		// indistinguishable from the target signing in themselves. Revoke it
		// rather than leave an unattributable session behind.
		_ = s.limen.RevokeSession(ctx, result.Token)
		return err
	}

	if err := s.core.Cookies().SetSessionCookie(w, result); err != nil {
		return fmt.Errorf("auth: set impersonated session cookie: %w", err)
	}
	return nil
}

// StopImpersonating reverses Impersonate: it restores the admin's own session
// cookie from the marker written at impersonation time, then revokes the
// impersonated session so the token cannot be replayed.
//
// The admin token is read back from the database rather than carried on the
// Session value, so a StopImpersonating call cannot be talked into restoring
// a session the caller merely claims to own.
func (s *service) StopImpersonating(ctx context.Context, w http.ResponseWriter, _ *http.Request, session *Session) error {
	if session == nil || session.ImpersonatedBy == "" {
		return ErrNotImpersonating
	}

	metadata, err := s.sessionMetadata(ctx, session.Token)
	if err != nil {
		return err
	}

	adminToken, _ := metadata[metaAdminToken].(string)
	if adminToken == "" {
		return errors.New("auth: impersonated session carries no admin token")
	}

	admin, err := s.q.GetSessionRecord(ctx, adminToken)
	if err != nil {
		return fmt.Errorf("auth: the admin session to restore is gone: %w", err)
	}

	maxAge := int(time.Until(admin.ExpiresAt.Time).Seconds())
	if maxAge <= 0 {
		return errors.New("auth: the admin session to restore has expired")
	}
	s.core.Cookies().Set(w, sessionCookieName, adminToken, maxAge)

	if err := s.limen.RevokeSession(ctx, session.Token); err != nil {
		return fmt.Errorf("auth: revoke impersonated session: %w", err)
	}
	return nil
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
