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
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

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

// roleOwner mirrors middleware.roleOwner: Limen's organization plugin can
// still assign its default "owner" role even though Pjokk's own creation
// path always uses RoleAdmin (see New's WithCreatorRole) — accepted for
// reading here too, same as middleware.RequireAdmin, so the last-admin
// guard below treats an "owner" exactly like an "admin".
const roleOwner = "owner"

// IsPrivilegedRole reports whether role is one of the two values that count
// as "runs the family" for the last-admin guard (RemoveMember,
// SetMemberRole): admin, or Limen's "owner".
//
// Exported so a caller can ANTICIPATE the guard rather than only react to
// ErrLastAdmin. internal/api's admin console needs that: it writes an audit
// row before every mutation, and a row describing a demotion that was then
// refused is a false entry in an append-only trail. The guard inside the
// transaction stays authoritative — this only lets a caller avoid recording
// an action it can already see will not happen.
func IsPrivilegedRole(role string) bool {
	return role == RoleAdmin || role == roleOwner
}

// isPrivilegedRole is the unexported spelling this package uses internally.
func isPrivilegedRole(role string) bool { return IsPrivilegedRole(role) }

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
	// ErrLastAdmin is returned by RemoveMember and SetMemberRole when the
	// write would leave the family with no admin/owner at all: removing the
	// sole admin, or demoting them to a plain member. It is a business-rule
	// rejection depending on the family's current membership, not a tenancy
	// or not-found failure — callers map it to a 400, never a 403/404. Only
	// the SPA enforced this before; any direct API call (or a second admin
	// acting on the first) could otherwise strand a family with a role no
	// one holds.
	ErrLastAdmin = errors.New("auth: cannot remove or demote the family's last admin")
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

// NormalizeEmail is the canonical form addresses are STORED in, exported so
// that code outside this package can match a users row by email without
// importing Limen (nothing outside internal/auth may) and, more to the
// point, without guessing at the rule. Guessing would work right up until
// the library changed it, at which point a lookup would silently miss and
// an operator would be told an account does not exist.
func NormalizeEmail(email string) string {
	return limen.NormalizeEmail(email)
}

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

	// SessionFromRequestRefreshing is SessionFromRequest plus the sliding-
	// session cookie write, and is what every HTTP path should call. See its
	// doc comment in session.go for why a resolver needs a ResponseWriter.
	SessionFromRequestRefreshing(w http.ResponseWriter, r *http.Request) (*Session, error)

	// CreateUser creates an account. An empty password creates a user with
	// no usable credential — the invite-redeem path, where the account is
	// provisioned first and the person signs in with Google afterwards.
	CreateUser(ctx context.Context, name, email, password string) (userID string, err error)

	CreateFamily(ctx context.Context, userID, name string) (familyID string, err error)

	// CreateFamilyForUser creates a family whose first admin is ownerUserID,
	// on the authority of a system administrator rather than the owner's
	// own — the operator console's manual family creation. See the
	// implementation for why the ordinary CreateFamily cannot serve it.
	CreateFamilyForUser(ctx context.Context, ownerUserID, name string) (familyID string, err error)

	// CreateEmptyFamily creates a family with no members, for the operator
	// console's invite-only creation path. operatorUserID is a momentary
	// member because Limen insists on one; see the implementation.
	CreateEmptyFamily(ctx context.Context, operatorUserID, name string) (familyID string, err error)
	AddMember(ctx context.Context, familyID, userID, role string) error
	RemoveMember(ctx context.Context, familyID, memberID string) error
	SetMemberRole(ctx context.Context, familyID, memberID, role string) error
	SetActiveFamily(ctx context.Context, sessionToken, familyID string) error

	// SetPassword also signs the user out everywhere, including every
	// session they are driving through impersonation (it sweeps those
	// itself, first — see users.go).
	SetPassword(ctx context.Context, userID, newPassword string) error
	RevokeAllSessions(ctx context.Context, userID string) error

	// RevokeImpersonatedSessions revokes every session this user is driving
	// through impersonation. RevokeAllSessions does NOT cover those: an
	// impersonated session's user_id is the TARGET's, so cutting off an
	// operator (ban, sign-out-everywhere, account deletion) must call both,
	// this one FIRST — revoking the operator's own sessions cascades away
	// the rows this one finds them by. SetPassword and RevokeSession do it
	// themselves. The session resolver refuses (and revokes) an
	// impersonated session whose operator is no longer an unbanned system
	// admin or whose record is gone, but that is a backstop, not a licence
	// to skip the call.
	RevokeImpersonatedSessions(ctx context.Context, adminUserID string) error

	// The operator console's user page (sessions.go, spec
	// 2026-09-11-admin-user-support §3): one person's live sessions — never
	// a token; signing one of them out by id (ErrSessionNotFound when it is
	// not theirs), which also ends any impersonation started from it; and
	// changing their login address (ErrEmailTaken when another account
	// holds it).
	UserSessions(ctx context.Context, userID string) ([]SessionInfo, error)
	RevokeSession(ctx context.Context, userID, sessionID string) error
	ChangeEmail(ctx context.Context, userID, email string) error

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

	// A standalone Queries wrapping the same pool, for the allowOrgCreation
	// closure below — built here because organization.New runs before the
	// service (and its own s.q) exists. gen.New is a thin wrapper with no
	// state of its own, so a second one over the same *pgxpool.Pool costs
	// nothing.
	authQueries := gen.New(cfg.Pool)

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
			// A security-review fix (H2 — "only system admins can
			// create families"): apps/api/src/infrastructure/auth.ts's
			// allowUserToCreateOrganization gate had NO Go-side equivalent.
			// organizations:create stays enabled in allowedRouteIDs above
			// for the SPA's self-serve founding + family switcher, but
			// without this hook ANY signed-in user — including one who
			// already belongs to a family — could call it directly and
			// spin up an arbitrary new family, admin of their own, wholly
			// bypassing the closed-alpha invite-code gate. Mirrors the TS
			// rule exactly: a system admin may always create; anyone else
			// may self-serve found ONE family while they hold zero
			// memberships, and must use an invite code after that.
			organization.WithAllowOrgCreation(func(ctx context.Context, user *limen.User) bool {
				return allowOrgCreation(ctx, authQueries, idString(user.ID), cfg.OpenSignup)
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
			// Record activity at most every five minutes on use, so the
			// console's "active 5 min ago" is true. Limen's default is 0,
			// which leaves last_access to move only when a session's expiry
			// is extended — at most daily — and the user page would show a
			// signed-in phone as idle for days. One write per session per
			// five minutes: the cadence API keys and kiosk devices use.
			limen.WithSessionActivityCheckInterval(5*time.Minute),
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
	// OAuth account creation is intentionally OPEN even under closed signup:
	// it is the only way a brand-new invitee can get the account they need to
	// redeem an invite (Limen has no per-invite signup gate). Safe because an
	// uninvited OAuth account cannot create a family (allowOrgCreation requires
	// OPEN_SIGNUP or sysadmin) or reach any family route, and the orphan purge
	// removes it after 7 days. Credential signup stays gated by OPEN_SIGNUP
	// (WithHTTPDisabledPaths above).
	return oauth.New(opts...)
}
