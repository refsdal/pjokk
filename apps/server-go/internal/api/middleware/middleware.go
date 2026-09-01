// Package middleware is Pjokk's request pipeline: who is calling, which
// family they are calling into, and whether they may.
//
// It implements REF §A5 item by item, porting apps/api/src/middleware/*.ts.
// The shipped chain applies them in the order the TypeScript app used —
// TrustedProxy, APIKeyAuth, Session, RequireFamily, then the role gates — and
// that order matters:
//
//   - TrustedProxy runs OUTSIDE everything, including Limen's own routes: it
//     rewrites r.RemoteAddr, which Limen's sign-in rate limiter and its
//     session-address digest both read.
//   - APIKeyAuth runs before Session so a pjk_ bearer resolves to a synthetic
//     identity and Session skips its cookie lookup.
//   - RequireFamily runs after both, so a key and a cookie get exactly the
//     same tenancy check — a key whose creator was removed from the family
//     stops working, like their session does.
//
// Nothing here imports internal/api (which imports this package to build the
// handler); the shared error envelope lives in internal/api/respond.
package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/respond"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
)

// Deps is what the chain needs from the composition root. It is a separate
// struct from api.Deps (rather than that one being passed down) so this
// package stays free of the API surface it guards — and so a test can build a
// chain from three fields instead of the whole application.
type Deps struct {
	Auth      auth.Service
	Q         *gen.Queries
	RateLimit ratelimit.Store

	// Now is the clock, injectable for tests. nil means time.Now.
	Now func() time.Time
}

func (d Deps) now() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

// FamilyCtx is what a handler behind RequireFamily knows about its caller:
// who they are, which family the request runs in, what they may do there, and
// how they authenticated.
//
// Resources are owned by the family, never by the user (CLAUDE.md), so
// FamilyID is the scope every domain query is written against.
type FamilyCtx struct {
	UserID     string
	UserName   string
	FamilyID   string
	MemberRole string // "admin" | "member" (Limen's "owner" is possible but unused)
	Plan       string // free | premium | lifetime | comp

	// IsAPIKey marks a request authenticated by a pjk_ bearer key rather
	// than a human session. Admin and device-bound endpoints refuse these.
	IsAPIKey bool

	// ImpersonatedBy is the system admin driving this session, or "".
	ImpersonatedBy string
}

// contextKey keeps this package's context values from colliding with anyone
// else's (the untyped-string trap net/http's own docs warn about).
type contextKey int

const (
	identityKey contextKey = iota
	familyKey
)

// identity is the resolved caller, session-or-key, stored once per request.
// A nil session means "nobody is signed in" — an answer, not a missing value,
// which is why presence of the identity itself is what "already resolved"
// means.
type identity struct {
	session  *auth.Session
	isAPIKey bool
}

func identityFrom(r *http.Request) (identity, bool) {
	id, ok := r.Context().Value(identityKey).(identity)
	return id, ok
}

func withIdentity(r *http.Request, id identity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), identityKey, id))
}

// SessionFrom returns the resolved session, or nil when the caller is
// anonymous or authenticated by an API key's synthetic identity.
func SessionFrom(r *http.Request) *auth.Session {
	id, _ := identityFrom(r)
	return id.session
}

// IsAPIKey reports whether this request was authenticated by a pjk_ key.
func IsAPIKey(r *http.Request) bool {
	id, _ := identityFrom(r)
	return id.isAPIKey
}

// Family returns the tenancy context RequireFamily established. The zero
// value means the request never passed RequireFamily — which is a wiring bug,
// not a runtime condition: no handler should be reachable without it.
func Family(r *http.Request) FamilyCtx {
	ctx, _ := r.Context().Value(familyKey).(FamilyCtx)
	return ctx
}

// Session resolves the caller once per request and never rejects (REF §A5
// item 1): routes decide what an anonymous request means. It is skipped
// entirely when APIKeyAuth already established an identity.
//
// It uses the auth service's refreshing resolver, so a sliding session's
// extended cookie actually reaches the browser — see
// auth.Service.SessionFromRequestRefreshing.
//
// A database failure is NOT reported as "signed out": that would silently
// downgrade an outage into a 401 storm and, worse, let a route that treats
// anonymity as a valid state carry on. It is a 500.
func Session(d Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := identityFrom(r); ok {
				next.ServeHTTP(w, r)
				return
			}
			session, err := d.Auth.SessionFromRequestRefreshing(w, r)
			if err != nil {
				respond.Error(w, http.StatusInternalServerError, "session lookup failed", "INTERNAL")
				return
			}
			next.ServeHTTP(w, withIdentity(r, identity{session: session}))
		})
	}
}

// RequireFamily is the tenancy gate (REF §A5 item 2). Every domain route sits
// behind it: it resolves the family from the session's active organization
// and verifies the membership row actually exists — an activeOrganizationId
// alone is not proof, because it survives the member being removed.
//
// Writes made while impersonating leave a trail carrying both identities.
// That insert is best-effort: an audit failure must not deny a caretaker the
// ability to log a feed, and the write itself is already recorded elsewhere.
func RequireFamily(d Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, _ := identityFrom(r)
			session := id.session
			if session == nil {
				respond.Error(w, http.StatusUnauthorized, "Not signed in", "UNAUTHENTICATED")
				return
			}
			if session.ActiveFamilyID == "" {
				respond.Error(w, http.StatusForbidden, "No active family", "NO_FAMILY")
				return
			}

			membership, err := d.Q.GetFamilyMembershipRole(r.Context(), gen.GetFamilyMembershipRoleParams{
				OrganizationID: session.ActiveFamilyID,
				UserID:         session.UserID,
			})
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				respond.Error(w, http.StatusForbidden, "Not a member of this family", "NOT_MEMBER")
				return
			case err != nil:
				respond.Error(w, http.StatusInternalServerError, "membership lookup failed", "INTERNAL")
				return
			}

			family := FamilyCtx{
				UserID:         session.UserID,
				UserName:       session.Name,
				FamilyID:       session.ActiveFamilyID,
				MemberRole:     membership.Role,
				Plan:           membership.Plan,
				IsAPIKey:       id.isAPIKey,
				ImpersonatedBy: session.ImpersonatedBy,
			}

			if family.ImpersonatedBy != "" && !isRead(r.Method) {
				Audit(r.Context(), d.Q, family.ImpersonatedBy, "impersonated.write",
					family.UserID, fmt.Sprintf("%s %s", r.Method, r.URL.Path))
			}

			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), familyKey, family)))
		})
	}
}

// RequireAdmin gates the family-administration surface — settings, invites,
// keys, billing (REF §A5 item 3). It reads the role RequireFamily resolved,
// so it must be mounted behind it.
//
// "owner" is accepted alongside "admin": Pjokk assigns neither by name but
// Limen's organization plugin can, and a family owner locked out of their own
// settings would be an absurd failure mode.
func RequireAdmin() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			family := Family(r)
			if family.IsAPIKey {
				respond.Error(w, http.StatusForbidden, "Not available to API keys", "FORBIDDEN")
				return
			}
			if family.MemberRole != auth.RoleAdmin && family.MemberRole != roleOwner {
				respond.Error(w, http.StatusForbidden, "Admin only", "FORBIDDEN")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Audit appends a row to the system-admin trail (REF §A5 item 4's helper).
// An empty detail is stored as NULL.
//
// It returns nothing on purpose: every caller — the impersonated-write trail
// below and the /admin console alike — treats the trail as best-effort. An
// audit insert that fails must not turn a legitimate action into an error the
// operator cannot get past; the alternative is an admin console that stops
// working whenever its own bookkeeping does.
func Audit(ctx context.Context, q *gen.Queries, adminID, action, target, detail string) {
	params := gen.InsertAdminAuditParams{AdminID: adminID, Action: action, Target: target}
	if detail != "" {
		params.Detail = &detail
	}
	_ = q.InsertAdminAudit(ctx, params)
}

// roleOwner is Limen's default creator role. Pjokk configures "admin"
// instead (auth.New), so this only ever appears on a row some other tool
// wrote — accepted for reading, never assigned.
const roleOwner = "owner"

// RequireSysadmin gates the /admin console (REF §A5 item 4). System admins
// are users whose own users.role is "admin" — a column of ours, unrelated to
// per-family roles, and never reachable with an API key.
func RequireSysadmin() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, _ := identityFrom(r)
			if id.session == nil {
				respond.Error(w, http.StatusUnauthorized, "Not signed in", "UNAUTHENTICATED")
				return
			}
			if id.isAPIKey {
				respond.Error(w, http.StatusForbidden, "Not available to API keys", "FORBIDDEN")
				return
			}
			if id.session.Role != auth.RoleSystemAdmin {
				respond.Error(w, http.StatusForbidden, "System admin only", "FORBIDDEN")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// apiKeyPrefix is the token prefix that marks a bearer as one of ours. Only
// these are treated as key auth; every other bearer belongs to Limen (its
// bearer plugin accepts session tokens the same way) and falls through.
const apiKeyPrefix = "pjk_"

// lastUsedInterval is how coarse last_used_at tracking is: one write per key
// per five minutes, not one per request.
const lastUsedInterval = 5 * time.Minute

// APIKeyAuth authenticates `Authorization: Bearer pjk_…` (REF §A5 item 5).
//
// A key authenticates AS the caretaker who created it — their name ends up on
// the logs it writes — scoped to the key's family. The stored value is a
// SHA-256 of the token, so a database leak does not hand over working keys.
//
// A request with no pjk_ bearer passes through untouched; this middleware is
// mounted on the whole API, not just the key-authenticated part.
//
// The 402 premium gate the TypeScript version applied here is deliberately
// gone (REF §A5 item 5).
func APIKeyAuth(d Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			const bearer = "Bearer "
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, bearer+apiKeyPrefix) {
				next.ServeHTTP(w, r)
				return
			}
			sum := sha256.Sum256([]byte(strings.TrimPrefix(header, bearer)))

			key, err := d.Q.GetAPIKeyByHash(r.Context(), hex.EncodeToString(sum[:]))
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				// Revoked keys are filtered by the query, so a revoked key is
				// indistinguishable from one that never existed.
				respond.Error(w, http.StatusUnauthorized, "Invalid API key", "INVALID_KEY")
				return
			case err != nil:
				respond.Error(w, http.StatusInternalServerError, "API key lookup failed", "INTERNAL")
				return
			}

			now := d.now()
			if key.ExpiresAt.Valid && !key.ExpiresAt.Time.After(now) {
				respond.Error(w, http.StatusUnauthorized, "API key expired", "KEY_EXPIRED")
				return
			}
			if key.ReadOnly && !isRead(r.Method) {
				respond.Error(w, http.StatusForbidden, "This API key is read-only", "READ_ONLY_KEY")
				return
			}

			// Synthetic session: only the fields the tenancy layer and the
			// handlers read. Role stays empty — a key is never a system
			// admin, and RequireSysadmin refuses key auth outright anyway.
			session := &auth.Session{
				UserID:         key.UserID,
				Name:           key.UserName,
				Email:          key.UserEmail,
				ActiveFamilyID: key.FamilyID,
			}

			if !key.LastUsedAt.Valid || now.Sub(key.LastUsedAt.Time) > lastUsedInterval {
				// Best-effort: a failed bookkeeping write must not deny a
				// working key.
				_ = d.Q.TouchAPIKey(r.Context(), gen.TouchAPIKeyParams{
					ID:         key.ID,
					LastUsedAt: pgtype.Timestamptz{Time: now, Valid: true},
				})
			}

			next.ServeHTTP(w, withIdentity(r, identity{session: session, isAPIKey: true}))
		})
	}
}

// RejectAPIKey guards the endpoints that only make sense for a human session
// — push subscriptions bound to a browser, billing, admin management (REF §A5
// item 6).
func RejectAPIKey() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if IsAPIKey(r) {
				respond.Error(w, http.StatusForbidden, "Not available to API keys", "FORBIDDEN")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimit is the fixed-window counter (REF §A5 item 8).
//
// global buckets every client together: it defeats distributed guessing at
// the cost of shared-fate 429s, so it is only used with generous limits
// alongside a per-IP limiter. Otherwise the bucket is a hash of the client
// address — never the address itself. Cloudflare KV forced that (globally
// replicated, no jurisdiction option); the counters now live in the same EU
// database as everything else, but there is still no reason to record
// addresses, and a digest buckets each client just as well.
//
// hops is TRUSTED_PROXY_HOPS. It is passed here as well as to TrustedProxy
// because a limiter mounted on a handler that TrustedProxy did not wrap must
// still resolve the same address; when both are in play the header simply
// resolves to the address already in RemoteAddr.
//
// A store failure denies the request. The alternative — failing open — turns
// a database blip into an open door on exactly the endpoints that have one.
func RateLimit(store ratelimit.Store, name string, limit, windowSeconds int, global bool, hops int) func(http.Handler) http.Handler {
	if store == nil {
		panic("middleware: RateLimit needs a counter store")
	}
	if windowSeconds <= 0 {
		panic("middleware: RateLimit needs a positive window")
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			bucket := "global"
			if !global {
				address := ratelimit.ClientIP(r.Header.Get("X-Forwarded-For"), r.RemoteAddr, hops)
				sum := sha256.Sum256([]byte(address))
				bucket = hex.EncodeToString(sum[:])[:32]
			}
			// Wall clock, not Deps.Now: the window number is part of the key
			// every replica shares, so it must not be something one process
			// can be talked into disagreeing about.
			window := time.Now().Unix() / int64(windowSeconds)
			key := fmt.Sprintf("rl:%s:%s:%d", name, bucket, window)

			count, err := store.Hit(r.Context(), key, windowSeconds)
			if err != nil {
				respond.Error(w, http.StatusInternalServerError, "rate limit check failed", "INTERNAL")
				return
			}
			if count > limit {
				respond.Error(w, http.StatusTooManyRequests, "Too many attempts, try again later", "RATE_LIMITED")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// TrustedProxy rewrites r.RemoteAddr to the address the outermost trusted
// proxy observed, and must wrap the ENTIRE handler — Limen's routes included.
//
// net/http sets RemoteAddr from the socket before any handler runs, and two
// things inside Limen read it: its own sign-in rate limiter and the digest it
// stores as a session's client address. Behind an ingress every request
// arrives from the ingress's address, so without this rewrite both collapse
// into a single shared bucket — the limiter stops distinguishing attackers
// from everyone else, and every session records the same "device".
//
// With TRUSTED_PROXY_HOPS at its default 0 this is a no-op: X-Forwarded-For
// is caller-supplied, and reading it unasked would let anyone forge an
// address. See ratelimit.ClientIP for how the hop count is applied.
func TrustedProxy(hops int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if hops <= 0 {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			address := ratelimit.ClientIP(r.Header.Get("X-Forwarded-For"), r.RemoteAddr, hops)
			if address == "" || address == "unknown" {
				next.ServeHTTP(w, r)
				return
			}
			// Keep the host:port shape net/http guarantees, so anything
			// downstream that splits the address still works. The port is the
			// original connection's — meaningless for the real client, and
			// nothing reads it.
			if _, port, err := net.SplitHostPort(r.RemoteAddr); err == nil {
				address = net.JoinHostPort(address, port)
			}
			// Shallow copy: the caller's request must not be mutated, and the
			// header map is shared read-only from here on.
			rewritten := *r
			rewritten.RemoteAddr = address
			next.ServeHTTP(w, &rewritten)
		})
	}
}

// isRead reports whether the method is one of the two the rules treat as
// non-mutating: read-only keys may use them, and impersonating them is not
// audited.
func isRead(method string) bool {
	return method == http.MethodGet || method == http.MethodHead
}
