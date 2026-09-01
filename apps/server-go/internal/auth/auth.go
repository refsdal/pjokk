// Package auth is the ONLY package in this module that imports Limen.
//
// Everything outside it — routes, middleware, jobs, the admin console —
// consumes the Service interface and the Session struct declared here, and
// never a Limen type. That boundary is not decoration: Limen's organization
// plugin is v0.1.0, its session APIs take *limen.Session values whose ID
// fields are `any`, and its schema is discovered rather than declared. Any of
// that can change under us; the blast radius has to stop at this package.
//
// This replaces apps/server's better-auth instance: an organization IS a
// family, family roles are admin (parents) and member, and the system-level
// "admin" role — the one that opens /admin — is a separate column on our own
// users table, deliberately not a Limen concept.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/thecodearcher/limen"
	sqladapter "github.com/thecodearcher/limen/adapters/sql"
	credentialpassword "github.com/thecodearcher/limen/plugins/credential-password"
	"github.com/thecodearcher/limen/plugins/oauth"
	oauthgoogle "github.com/thecodearcher/limen/plugins/oauth-google"
	"github.com/thecodearcher/limen/plugins/organization"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// BasePath is where the auth routes live. Limen's router matches the FULL
// request path (its base path is a router group, not a prefix that gets
// stripped), so the value here and the mount point in the HTTP server must
// agree exactly — mounting Handler() anywhere else yields 404s for every
// auth route, with no error at startup to explain it.
const BasePath = "/api/auth"

// sessionCookieName is pinned rather than left to Limen's default so the two
// can never drift apart under a library upgrade. The cookie is HttpOnly, so
// no client reads it by name.
const sessionCookieName = "limen_session"

// Family roles. An organization IS a family: parents are admins (settings,
// invites, deletes), everyone else logs and views.
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// RoleSystemAdmin is the value of Session.Role that opens the /admin console.
// It comes from our own users.role column and has nothing to do with the
// family roles above.
const RoleSystemAdmin = "admin"

// Errors callers are expected to branch on.
var (
	// ErrNotSystemAdmin is returned when a non-admin attempts an operation
	// reserved for the system administrator.
	ErrNotSystemAdmin = errors.New("auth: not a system administrator")
	// ErrNotImpersonating is returned by StopImpersonating when the session
	// is an ordinary one.
	ErrNotImpersonating = errors.New("auth: session is not impersonating")
	// ErrUnknownRole is returned when a role outside the family vocabulary
	// is supplied.
	ErrUnknownRole = errors.New("auth: unknown family role")
	// ErrMemberNotInFamily is returned when a member id does not belong to
	// the family it was addressed under — the tenancy guard for the two
	// member-mutating methods.
	ErrMemberNotInFamily = errors.New("auth: member does not belong to this family")
	// ErrEmailTaken is returned when an account already exists for an email.
	ErrEmailTaken = errors.New("auth: an account already exists for this email")
	// ErrNotFamilyMember is returned by SetActiveFamily when the session's
	// user is not a member of the family they asked to switch to. Callers
	// should map it to 403 — it is an authorization failure, not a 404: the
	// family exists, this user simply may not enter it.
	ErrNotFamilyMember = errors.New("auth: user is not a member of this family")
	// ErrSessionNotFound is returned when a supplied session token has no
	// live session behind it.
	ErrSessionNotFound = errors.New("auth: session not found")
)

// Session is what the rest of the app knows about the caller. It is
// assembled from Limen's validated session plus one query against our own
// users/sessions columns, because the fields the app actually branches on
// (system role, ban state, active family) are ours, not Limen's.
type Session struct {
	UserID, Name, Email, Role string // Role is "" or "admin" (system role)
	Banned                    bool
	ActiveFamilyID            string // "" when none
	Token                     string
	ImpersonatedBy            string // "" when not impersonating
}

// Service is the entire auth surface the rest of the app may use.
//
// Banning: setting users.banned is NOT by itself a revocation. Existing
// sessions stay in the database; SessionFromRequest reports them as signed
// out and Handler rejects them on Limen's own routes, but a bearer token
// still exists and the row still counts. Whatever bans an account MUST also
// call RevokeAllSessions for that user, so the ban is enforced by absence
// rather than by every reader remembering to check a flag.
type Service interface {
	Handler() http.Handler                                // mount at /api/auth/
	SessionFromRequest(r *http.Request) (*Session, error) // nil,nil when no session

	// CreateUser creates an account. An empty password creates a user with
	// no usable credential — the invite-redeem path, where the account is
	// provisioned first and the person signs in with Google afterwards.
	CreateUser(ctx context.Context, name, email, password string) (userID string, err error)

	CreateFamily(ctx context.Context, userID, name string) (familyID string, err error)
	AddMember(ctx context.Context, familyID, userID, role string) error
	RemoveMember(ctx context.Context, familyID, memberID string) error
	SetMemberRole(ctx context.Context, familyID, memberID, role string) error
	SetActiveFamily(ctx context.Context, sessionToken, familyID string) error
	SetPassword(ctx context.Context, userID, newPassword string) error
	RevokeAllSessions(ctx context.Context, userID string) error

	Impersonate(ctx context.Context, w http.ResponseWriter, r *http.Request, adminSession *Session, targetUserID string) error
	StopImpersonating(ctx context.Context, w http.ResponseWriter, r *http.Request, s *Session) error
}

// Config is everything the auth service needs from the composition root. It
// takes an already-open pool rather than a URL: one process, one pool.
type Config struct {
	AppURL             string
	Secret             string
	GoogleClientID     string
	GoogleClientSecret string
	OpenSignup         bool
	Pool               *pgxpool.Pool
}

type service struct {
	limen *limen.Limen
	core  *limen.LimenCore
	org   organization.API
	cred  credentialpassword.API
	pool  *pgxpool.Pool
	q     *gen.Queries
}

var _ Service = (*service)(nil)

// New builds the Limen instance and wires it to our schema.
//
// The instance is built ONCE, at startup, and shared by every request. It
// used to be per-request on Workers because the D1 binding only existed
// inside the handler, which rebuilt the whole plugin chain on every call;
// see CLAUDE.md. Do not reintroduce that.
func New(cfg Config) (Service, error) {
	switch {
	case cfg.Pool == nil:
		return nil, errors.New("auth: a database pool is required")
	case cfg.AppURL == "":
		return nil, errors.New("auth: AppURL is required")
	case len(cfg.Secret) < 32:
		return nil, errors.New("auth: Secret must be at least 32 bytes")
	}

	// Limen speaks database/sql, we speak pgx. OpenDBFromPool wraps the pool
	// we were handed rather than opening a second one, so there is still
	// exactly one connection pool in the process. The *sql.DB borrows from
	// the pool and is finished when the pool is closed by its owner.
	sqlDB := stdlib.OpenDBFromPool(cfg.Pool)

	core := &corePlugin{}
	plugins := []limen.Plugin{
		credentialpassword.New(),
		organization.New(
			// The family's creator is a parent, so they get our admin role
			// rather than Limen's default "owner" — Pjokk's vocabulary has
			// exactly two family roles and "owner" is not one of them.
			organization.WithCreatorRole(RoleAdmin),
			// One slug rule for both entry points. Limen's own
			// POST /organizations route stays enabled for the SPA, and its
			// default generator derives the slug from the name alone — so
			// the second family called "Hansen" would fail to be created.
			// familySlug appends a random suffix; routing both paths through
			// it means CreateFamily and the HTTP route cannot disagree.
			organization.WithSlugGenerator(func(name, provided string) string {
				if provided != "" {
					return provided
				}
				return familySlug(name)
			}),
		),
		core,
	}
	if cfg.GoogleClientID != "" && cfg.GoogleClientSecret != "" {
		plugins = append(plugins, googlePlugin(cfg))
	}

	// Limen requires exactly 32 bytes; our AUTH_SECRET is a free-form string
	// of at least 32. Hashing gives a stable 32-byte key from any valid
	// secret without asking operators to count characters.
	secret := sha256.Sum256([]byte(cfg.Secret))

	// A separate key, domain-separated from the signing secret, for the
	// client-address digests below.
	ipDigest := clientIPDigest(sha256.Sum256([]byte(cfg.Secret + ipDigestDomain)))

	instance, err := limen.New(&limen.Config{
		BaseURL:  cfg.AppURL,
		Database: sqladapter.NewPostgreSQL(sqlDB),
		Secret:   secret[:],
		Schema: limen.NewDefaultSchemaConfig(
			// Without a generator Limen assumes auto-increment integer keys;
			// every id in this schema is text.
			limen.WithSchemaIDGenerator(uuidGenerator{}),
		),
		Session: limen.NewDefaultSessionConfig(
			// Cookies for the web app, bearer tokens for a future Capacitor
			// shell. Both coexist, per CLAUDE.md.
			limen.WithBearerEnabled(),
			// Limen stores the client IP in the session's metadata by
			// default. Article 9 health data plus raw addresses is exactly
			// what the privacy policy promises not to do, so sessions record
			// a keyed digest of the address instead — enough to tell two
			// devices apart, useless for locating anyone.
			limen.WithSessionIPAddressExtractor(ipDigest),
		),
		HTTP: limen.NewDefaultHTTPConfig(
			limen.WithHTTPBasePath(BasePath),
			limen.WithHTTPSessionCookieName(sessionCookieName),
			// A self-hosted instance behind plain HTTP (or a dev machine)
			// would silently never receive a Secure cookie.
			limen.WithHTTPCookieSecure(strings.HasPrefix(cfg.AppURL, "https://")),
			limen.WithHTTPDisabledPaths(disabledRouteIDs(cfg.OpenSignup)),
			// Same reasoning as the session extractor: the built-in limiter
			// keys its buckets on the raw remote address.
			limen.WithHTTPRateLimiter(limen.WithRateLimiterKeyGenerator(ipDigest)),
		),
		Plugins: plugins,
	})
	if err != nil {
		return nil, fmt.Errorf("auth: build limen: %w", err)
	}

	// Limen hands the core to every plugin's Initialize; if that never
	// happened, impersonation would nil-panic on the first admin action
	// instead of failing here, at startup, where it is obvious.
	if core.core == nil {
		return nil, errors.New("auth: limen did not initialize the core plugin")
	}

	return &service{
		limen: instance,
		core:  core.core,
		org:   organization.Use(instance),
		cred:  credentialpassword.Use(instance),
		pool:  cfg.Pool,
		q:     gen.New(cfg.Pool),
	}, nil
}

// googlePlugin builds the OAuth plugin. Google's callback lands on
// {APP_URL}/api/auth/oauth/google/callback.
func googlePlugin(cfg Config) limen.Plugin {
	opts := []oauth.ConfigOption{
		oauth.WithProviders(oauthgoogle.New(
			oauthgoogle.WithClientID(cfg.GoogleClientID),
			oauthgoogle.WithClientSecret(cfg.GoogleClientSecret),
		)),
		// Google hands us a display name and an avatar; both are columns we
		// added to users, so they have to be mapped explicitly — Limen only
		// writes the columns it knows about.
		oauth.WithMapProfileToUser(func(info *limen.OAuthAccountProfile) map[string]any {
			fields := map[string]any{}
			if info.Name != "" {
				fields["name"] = info.Name
			}
			if info.AvatarURL != "" {
				fields["image"] = info.AvatarURL
			}
			return fields
		}),
	}
	if !cfg.OpenSignup {
		// Closed signup has to cover Google too, or "no open signup" means
		// "no open signup unless you own a Google account". With this set,
		// an unknown email gets ErrAccountNotFound instead of a new user;
		// the invite-redeem flow provisions the account first (CreateUser
		// with an empty password) and Google then links to it.
		opts = append(opts, oauth.WithRequireExplicitSignUp())
	}
	return oauth.New(opts...)
}

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
// session read, and the three organization routes the family switcher uses
// (create, list, switch). Signup is kept only when signup is open.
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

// CreateFamily creates the organization and makes userID its first member
// with the admin role.
func (s *service) CreateFamily(ctx context.Context, userID, name string) (string, error) {
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

		if err := q.ClearActiveFamilyForUser(ctx, gen.ClearActiveFamilyForUserParams{
			ActiveOrganizationID: &familyID,
			UserID:               member.UserID,
		}); err != nil {
			return fmt.Errorf("auth: clear active family: %w", err)
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
		if _, err := q.GetFamilyMember(ctx, gen.GetFamilyMemberParams{
			OrganizationID: familyID,
			ID:             memberID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrMemberNotInFamily
			}
			return fmt.Errorf("auth: load member: %w", err)
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

// SetPassword sets a password for a user who may not have a usable one
// (an OAuth or invite-provisioned account), revoking their other sessions:
// an administrator changing someone's password is either a recovery or a
// response to a compromise, and both want the old sessions gone.
func (s *service) SetPassword(ctx context.Context, userID, newPassword string) error {
	user, err := s.core.DBAction.FindUserByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("auth: load user: %w", err)
	}
	if err := s.cred.SetPassword(ctx, user, newPassword, true); err != nil {
		return fmt.Errorf("auth: set password: %w", err)
	}
	return nil
}

// RevokeAllSessions signs a user out everywhere.
func (s *service) RevokeAllSessions(ctx context.Context, userID string) error {
	if err := s.limen.RevokeAllSessions(ctx, userID); err != nil {
		return fmt.Errorf("auth: revoke sessions: %w", err)
	}
	return nil
}

// inTx runs fn inside one transaction with a transaction-scoped querier.
// Postgres has real transactions; the D1-era pattern of a batch plus a
// separate ownership check does not need to come back (CLAUDE.md).
func (s *service) inTx(ctx context.Context, fn func(*gen.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("auth: begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(gen.New(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: commit transaction: %w", err)
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

// ipDigestDomain separates the client-address key from the signing secret,
// so the two can never be the same bytes even though both derive from
// AUTH_SECRET.
const ipDigestDomain = ":client-ip"

// clientIPDigest builds the extractor both Limen's rate limiter and its
// session metadata use in place of the raw client address.
//
// HMAC rather than a bare hash: the address space is small enough to
// enumerate (a bare SHA-256 of an IPv4 address is reversible with a rainbow
// table in seconds), so the digest is only unlinkable if it is keyed. The
// key is instance-local, which is the right scope — the digest only ever
// needs to be comparable within one deployment.
//
// It reads RemoteAddr only: proxy-header handling (TRUSTED_PROXY_HOPS)
// belongs to the HTTP server that sets RemoteAddr, not here, and guessing at
// X-Forwarded-For inside the auth layer is how a limiter silently degrades
// to one shared bucket.
func clientIPDigest(key [32]byte) func(*http.Request) string {
	return func(r *http.Request) string {
		address := r.RemoteAddr
		if host, _, err := net.SplitHostPort(address); err == nil {
			address = host
		}
		mac := hmac.New(sha256.New, key[:])
		mac.Write([]byte(address))
		return hex.EncodeToString(mac.Sum(nil))
	}
}

// uuidGenerator supplies the text primary keys our schema declares. Limen
// would otherwise assume auto-increment integers and hand the database an
// int64 for a text column.
type uuidGenerator struct{}

func (uuidGenerator) Generate(context.Context) (any, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, fmt.Errorf("auth: generate id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func (uuidGenerator) GetColumnType() limen.ColumnType { return limen.ColumnTypeString }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read never returns an error on any platform this runs
		// on; treating it as fatal beats returning a predictable value.
		panic(fmt.Sprintf("auth: crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b)
}

// idString normalizes Limen's `any`-typed identifiers. With our generator
// they are always strings; the fallback keeps a surprise from becoming a
// panic.
func idString(id any) string {
	if s, ok := id.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", id)
}
