// Package api is the HTTP surface's composition point: it builds the
// /api/* handler from Deps (the collaborators the composition root in
// apps/server/cmd/pjokk assembles) and the generated OpenAPI-derived
// server code in internal/api/gen.
//
// package web wraps whatever NewHandler returns with static asset serving
// and REF §A9's headers; api.NewHandler itself is only ever reached for
// /api/* requests (see web.Handler's routing).
//
// # Route registration pattern (established by Task 9, followed by every
// route task after it)
//
// Every generated operation (a path+method in openapi/pjokk.yaml, one
// gen.StrictServerInterface method) is registered exactly once, through
// gen.NewStrictHandler + gen.HandlerWithOptions, on the SAME mux as
// everything else in this file. Two cross-cutting concerns wrap that
// registration, at two different generated-code layers:
//
//  1. Spec (request-shape) validation — kin-openapi checking a request
//     against the spec's parameter/body schema — is wired as a
//     gen.MiddlewareFunc via StdHTTPServerOptions.Middlewares. This layer
//     runs BEFORE the strict handler's own naive json.Decode of the
//     request body, which is the only point malformed JSON can be turned
//     into the standard {"error":"...","code":"VALIDATION"} envelope
//     instead of oapi-codegen's plain-text fallback. It has no
//     operationID to key off, so it is applied uniformly (harmless for
//     /healthz and /readyz, which have nothing to validate).
//  2. Auth (who + which family + what role) is wired as a single
//     gen.StrictMiddlewareFunc, via authChain, added to
//     gen.NewStrictHandler's middlewares argument. This layer runs AFTER
//     body decode, and DOES get the operationID — the only layer that
//     does — which is why per-operation gating lives here rather than in
//     (1). It looks up each operationID in operationAuthTiers and wraps
//     the call in the matching middleware.Session/RequireFamily/
//     RequireSession/RequireAdmin chain via adaptMiddleware, which lifts
//     those ordinary http.Handler middlewares (built once, unit-tested on
//     their own in internal/api/middleware) into the strict-server's
//     (ctx, w, r, request)-shaped world instead of reimplementing
//     authorization at that layer.
//
// A route task adding new operations MUST add each new operationID to
// operationAuthTiers with the tier its route table calls for
// (tierFamily is the default for ordinary family-scoped CRUD; tierAdmin
// for family-admin-only actions; tierSysadmin for the /admin console,
// which needs the system-admin role and no family at all; tierSession
// for the rare route, like GET /api/me, that wants a caller but not a
// family; tierPublic for none of the above). assertOperationAuthCoverage cross-checks the tier
// map against the embedded spec at NewHandler build time and panics on
// any mismatch in either direction — a missing entry (new spec operation,
// no tier assigned: fails loud rather than shipping unauthenticated) or a
// stale one (tier map entry with no matching spec operation: typo/rename
// protection). Handlers implementing the new methods live in their own
// file (see babies.go, me.go), each starting `var _ gen.StrictServerInterface
// = Deps{}` is enforced once in system.go — Deps grows one method per
// operation and must keep compiling against the whole interface.
package api

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/jackc/pgx/v5/pgxpool"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	"github.com/refsdal/pjokk/server/internal/auth"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/web"
)

// Deps is every collaborator the API layer needs, assembled by the
// composition root (apps/server/cmd/pjokk) and never constructed by this
// package itself (CLAUDE.md's Deps discipline, carried over from the
// TypeScript apps/api this package replaced).
//
// Storage, RateLimit and Push are minimal ports declared in their own
// packages ahead of their real implementations (Tasks 6/7) so this struct
// does not have to change shape when those land.
type Deps struct {
	Pool *pgxpool.Pool
	Q    *dbgen.Queries

	Auth auth.Service

	Storage   storage.Storage
	RateLimit ratelimit.Store
	Push      push.Sender

	Now func() time.Time

	AppURL           string
	VAPIDPublicKey   string
	TrustedProxyHops int

	// ExtraRoutes, when non-nil, is called while building the mux, after the
	// standard routes are registered and before the /api/ catch-all. protect
	// wraps a handler in the SAME Session + RequireFamily chain every real
	// family-scoped route will use from Task 9 on, so a route registered
	// through it is indistinguishable — from the middleware's point of
	// view — from a shipped one.
	//
	// This exists ONLY for internal/testrig's AppRig.MountProtected, which
	// needs to prove that chain end-to-end (200 with a family session, 403
	// NO_FAMILY without one) ahead of any real domain route existing yet.
	// Every real composition (cmd/pjokk) leaves this nil.
	ExtraRoutes func(mux *http.ServeMux, protect func(http.Handler) http.Handler)
}

// specYAML is a committed copy of the repo-root openapi/pjokk.yaml (see
// generate.go for why a copy is needed: go:embed cannot reach outside this
// module's own directory tree). It backs both the request-validation
// middleware and the /api/openapi.json route.
//
//go:embed pjokk.yaml
var specYAML []byte

// loadSpec parses and validates the embedded spec. Called once per
// NewHandler call; a failure here means the committed spec is broken, which
// should never survive `go generate` + review — panicking makes that loud
// at boot rather than silently serving an unvalidated API.
func loadSpec() *openapi3.T {
	loader := openapi3.NewLoader()
	spec, err := loader.LoadFromData(specYAML)
	if err != nil {
		panic(fmt.Sprintf("api: parse embedded spec: %v", err))
	}
	if err := spec.Validate(loader.Context); err != nil {
		panic(fmt.Sprintf("api: embedded spec is invalid: %v", err))
	}
	return spec
}

// authTier is how much of the middleware chain (REF §A5) an /api/ operation
// runs behind. See this package's doc comment for the full pattern.
type authTier int

const (
	// tierPublic runs no auth chain at all: liveness/readiness probes, plus
	// (from Task 20) GET /api/invites/info/{code} — the /join page's
	// pre-sign-in status check needs no caller at all.
	tierPublic authTier = iota
	// tierSession requires a resolved caller (session or API key) but NOT
	// an active family. Only GET /api/me uses this today.
	tierSession
	// tierFamily is the default for domain routes: caller + membership in
	// the active family (middleware.Session + middleware.RequireFamily).
	tierFamily
	// tierAdmin is tierFamily plus middleware.RequireAdmin — the
	// family-admin-only surface (member management, deleting a baby).
	tierAdmin
	// tierSysadmin is the /admin console (Task 20's sibling gate, REF §A5
	// item 4): a resolved session whose users.role is "admin" — OUR
	// system-admin column, unrelated to the per-family admin role tierAdmin
	// checks — and never an API key. Notably it does NOT require a family:
	// a system admin looking at platform stats or deleting somebody else's
	// family need not be a member of anything, so middleware.RequireFamily
	// is deliberately absent from this chain.
	tierSysadmin
	// tierFamilyNoAPIKey is tierFamily plus middleware.RejectAPIKey: a
	// caller (and family) must resolve exactly as tierFamily requires, but
	// a pjk_ bearer is then refused anyway. This is for endpoints bound to
	// a human, session-carrying browser rather than a programmatic caller —
	// push subscriptions today (REF §A5 item 6; apps/api/src/app.ts's
	// domainBase.use("/api/push/*", rejectApiKey), mounted AFTER
	// requireFamily, which is exactly this tier's ordering). Distinct from
	// tierAdmin: RejectAPIKey has nothing to do with the caller's role,
	// only how they authenticated.
	tierFamilyNoAPIKey
)

// operationAuthTiers maps every generated operationID (== the
// gen.StrictServerInterface method name) to the tier it runs behind.
// assertOperationAuthCoverage enforces that this stays exhaustive and
// exact against the embedded spec — see the package doc comment.
var operationAuthTiers = map[string]authTier{
	"Healthz": tierPublic,
	"Readyz":  tierPublic,

	"GetMe": tierSession,

	"ListBabies":        tierFamily,
	"CreateBaby":        tierFamily,
	"UpdateBaby":        tierFamily,
	"GetFamily":         tierFamily,
	"ListFamilyMembers": tierFamily,

	"ListFeeds":    tierFamily,
	"CreateFeed":   tierFamily,
	"UpdateFeed":   tierFamily,
	"DeleteFeed":   tierFamily,
	"ListDiapers":  tierFamily,
	"CreateDiaper": tierFamily,
	"UpdateDiaper": tierFamily,
	"DeleteDiaper": tierFamily,

	"ListSleeps":     tierFamily,
	"CreateSleep":    tierFamily,
	"GetActiveSleep": tierFamily,
	"WakeSleep":      tierFamily,
	"UpdateSleep":    tierFamily,
	"DeleteSleep":    tierFamily,

	// Play sessions (Task 13; REF §A1 play.ts). Structurally sleep's
	// active-session lifecycle one table over; free (no plan gate — see
	// internal/api/play.go's package doc comment).
	"ListPlays":     tierFamily,
	"CreatePlay":    tierFamily,
	"GetActivePlay": tierFamily,
	"StopPlay":      tierFamily,
	"UpdatePlay":    tierFamily,
	"DeletePlay":    tierFamily,

	"GetSummary": tierFamily,

	// The six Phase 3 activity types (Task 12; REF §A1 "other-logs.ts —
	// makeLogRoutes factory"). All 24 operations are tierFamily: every kind
	// is free (no plan gate) and every operation is ordinary family-scoped
	// CRUD, unlike sleep-locations' admin-only writes.
	"ListMedicine":      tierFamily,
	"CreateMedicine":    tierFamily,
	"UpdateMedicine":    tierFamily,
	"DeleteMedicine":    tierFamily,
	"ListBaths":         tierFamily,
	"CreateBath":        tierFamily,
	"UpdateBath":        tierFamily,
	"DeleteBath":        tierFamily,
	"ListNotes":         tierFamily,
	"CreateNote":        tierFamily,
	"UpdateNote":        tierFamily,
	"DeleteNote":        tierFamily,
	"ListMilestones":    tierFamily,
	"CreateMilestone":   tierFamily,
	"UpdateMilestone":   tierFamily,
	"DeleteMilestone":   tierFamily,
	"ListMeasurements":  tierFamily,
	"CreateMeasurement": tierFamily,
	"UpdateMeasurement": tierFamily,
	"DeleteMeasurement": tierFamily,
	"ListPumps":         tierFamily,
	"CreatePump":        tierFamily,
	"UpdatePump":        tierFamily,
	"DeletePump":        tierFamily,

	// ListSleepLocations is a plain family-scoped read; Create/Delete are
	// family-admin-only AND rejected for API keys (REF §A1
	// sleep-locations.ts). middleware.RequireAdmin already answers both
	// cases — "Not available to API keys"/FORBIDDEN before the role check,
	// "Admin only"/FORBIDDEN after — so tierAdmin alone reproduces the TS
	// route's two distinct 403s without any extra logic in
	// internal/api/sleep_locations.go.
	"ListSleepLocations":  tierFamily,
	"CreateSleepLocation": tierAdmin,
	"DeleteSleepLocation": tierAdmin,

	// Vaccines (Task 14; REF §A1 "vaccines.ts (+ files)"). Free, like the
	// six Phase 3 kinds above — dismissals are their own tierFamily
	// operations too, not folded into the log's tier. The multipart
	// document-upload route and /api/files/{id} streaming/delete are
	// hand-routed outside this generated interface entirely (see
	// internal/api/files.go and skipSpecValidation's vaccineDocumentsPattern
	// above) and therefore need no entry here.
	"ListVaccines":  tierFamily,
	"CreateVaccine": tierFamily,
	"UpdateVaccine": tierFamily,
	"DeleteVaccine": tierFamily,

	"ListVaccineDismissals":  tierFamily,
	"CreateVaccineDismissal": tierFamily,
	"DeleteVaccineDismissal": tierFamily,

	// Timeline (Task 15; REF §A1 timeline.ts): the merged, keyset-paginated
	// feed across all eleven kinds above. Ordinary family-scoped read.
	"ListTimeline": tierFamily,

	// Calendar + contacts (Task 16; REF §A1 calendar.ts/contacts.ts). Both
	// were premium-gated (402 on create) in the TS predecessor; this port
	// removes that gate entirely — every operation, including create, is
	// ordinary tierFamily CRUD (see internal/api/calendar.go's and
	// contacts.go's package doc comments).
	"ListCalendarEvents":  tierFamily,
	"CreateCalendarEvent": tierFamily,
	"UpdateCalendarEvent": tierFamily,
	"DeleteCalendarEvent": tierFamily,
	"ListContacts":        tierFamily,
	"CreateContact":       tierFamily,
	"UpdateContact":       tierFamily,
	"DeleteContact":       tierFamily,

	// Stats (Task 17; REF §A1 stats.ts). The TS predecessor's statsMonth
	// premium gate (402 when days>7) is removed — every window up to the
	// spec's 90-day cap is ordinary tierFamily. CSV export
	// (GET /api/export.csv) sits outside this map entirely: it is
	// hand-routed (internal/api/export.go), same as /api/files, behind
	// familyChain rather than authChain's operationID dispatch.
	"GetStats": tierFamily,

	// Push (Task 18; REF §A1 push.ts). Device/session-bound: every
	// operation is tierFamilyNoAPIKey, not plain tierFamily — see that
	// tier's doc comment and internal/api/push.go's package doc comment.
	"GetPushConfig":   tierFamilyNoAPIKey,
	"SubscribePush":   tierFamilyNoAPIKey,
	"UnsubscribePush": tierFamilyNoAPIKey,
	"GetPushPrefs":    tierFamilyNoAPIKey,
	"UpdatePushPrefs": tierFamilyNoAPIKey,
	"TestPush":        tierFamilyNoAPIKey,

	"DeleteBaby":          tierAdmin,
	"DeleteFamilyMember":  tierAdmin,
	"SetFamilyMemberRole": tierAdmin,

	// API keys (Task 19; REF §A1 keys.ts). Family-admin-only, same as
	// member management above: apps/api/src/app.ts mounts requireAdmin on
	// /api/keys/*, and requireAdmin itself already answers "Not available
	// to API keys"/FORBIDDEN before the role check (a key can never mint or
	// revoke another key) — see internal/api/keys.go. The TypeScript
	// predecessor's canUse(family, "apiKeys") 402 gate on create is removed
	// (this port's free-tier policy, matching every other Task 16-18 gate
	// removal).
	"ListApiKeys":  tierAdmin,
	"CreateApiKey": tierAdmin,
	"RevokeApiKey": tierAdmin,

	// Invites (Task 20; REF §A1 invites.ts). ListInvites/CreateInvite/
	// RevokeInvite are the family-admin management surface, same tier as
	// API keys above. GetInviteInfo is tierPublic — the /join page's
	// pre-sign-in status check — and RedeemInvite is tierSession: a caller
	// must be signed in, but (unlike every tierFamily/tierAdmin route) is
	// NOT required to already have an active family, since redeeming a
	// code is how one is acquired. Both public operations are additionally
	// rate-limited by rateLimitChain below — a concern this map doesn't
	// express, since it's orthogonal to who may call the operation at all.
	"ListInvites":   tierAdmin,
	"CreateInvite":  tierAdmin,
	"RevokeInvite":  tierAdmin,
	"GetInviteInfo": tierPublic,
	"RedeemInvite":  tierSession,

	// The system-admin console (Task 21; REF §A1 admin.ts, including its
	// "NEW in Go" table). Every operation is tierSysadmin — see that tier's
	// doc comment for why it is NOT tierAdmin and why it requires no family
	// — with one deliberate exception.
	//
	// StopImpersonating is tierSession, NOT tierSysadmin, and that is the
	// whole point: while an operator is impersonating an ordinary user, the
	// session driving the request IS the target's, whose users.role is
	// empty. RequireSysadmin would answer 403 and trap the operator inside
	// the impersonated session with no way back — the one endpoint that
	// must stay reachable is the exit. Nothing is opened up by this: the
	// handler reads the admin's identity from the session's own
	// impersonated_by marker (written server-side at impersonation time)
	// and refuses any session without one, so an ordinary user calling it
	// gets 400 NOT_IMPERSONATING and nothing else. See internal/api/
	// admin.go's StopImpersonating.
	"GetAdminStats":           tierSysadmin,
	"ListAdminFamilies":       tierSysadmin,
	"DeleteAdminFamily":       tierSysadmin,
	"ListAdminUsers":          tierSysadmin,
	"DeleteAdminUser":         tierSysadmin,
	"BanAdminUser":            tierSysadmin,
	"UnbanAdminUser":          tierSysadmin,
	"SetAdminUserPassword":    tierSysadmin,
	"RevokeAdminUserSessions": tierSysadmin,
	"ImpersonateAdminUser":    tierSysadmin,
	"StopImpersonating":       tierSession,
	"ListAdminAudit":          tierSysadmin,
	"CreateAdminAuditNote":    tierSysadmin,
}

// tierPublicAPIAllowlist is the exhaustive set of tierPublic operations
// permitted to live under /api/ — as opposed to Healthz/Readyz, which are
// tierPublic too but sit at the top level, outside /api/ entirely (see
// NewHandler's mount order). "No auth chain at all" is a much louder claim
// for a route nested under /api/ than for a liveness probe, so
// assertOperationAuthCoverage panics at boot if a future task's mistyped
// tier entry (meant tierFamily or tierSession, typed tierPublic) would
// otherwise ship an unauthenticated domain route silently. Extend this
// alongside operationAuthTiers when a new operation genuinely needs
// tierPublic under /api/ — and read why the existing entry needs it before
// adding another one next to it (GetInviteInfo's own doc comment in
// invites.go: the /join page's pre-sign-in status check).
var tierPublicAPIAllowlist = map[string]bool{
	"GetInviteInfo": true,
}

// assertOperationAuthCoverage panics unless operationAuthTiers has exactly
// one entry per operationId in spec — no fewer (a new route task that forgot
// to classify its operation) and no more (a stale entry left behind by a
// rename) — and, for every operation nested under /api/, panics if its tier
// is tierPublic without an explicit tierPublicAPIAllowlist entry (see that
// map's doc comment). Called once, at NewHandler build time, so a wiring
// mistake is a boot-time failure rather than a silently under-protected
// endpoint.
func assertOperationAuthCoverage(spec *openapi3.T) {
	seen := make(map[string]bool, len(operationAuthTiers))
	for _, path := range spec.Paths.InMatchingOrder() {
		item := spec.Paths.Find(path)
		for method, op := range item.Operations() {
			if op.OperationID == "" {
				panic(fmt.Sprintf("api: %s %s has no operationId", method, path))
			}
			name := strings.ToUpper(op.OperationID[:1]) + op.OperationID[1:]
			tier, ok := operationAuthTiers[name]
			if !ok {
				panic(fmt.Sprintf(
					"api: operation %q (%s %s) has no entry in operationAuthTiers — add one (see this package's doc comment)",
					name, method, path))
			}
			if tier == tierPublic && strings.HasPrefix(path, "/api/") && !tierPublicAPIAllowlist[name] {
				panic(fmt.Sprintf(
					"api: operation %q (%s %s) is tierPublic under /api/ but missing from tierPublicAPIAllowlist — "+
						"either that's a mistake (this route needs a real tier) or it's deliberate and belongs in the allowlist",
					name, method, path))
			}
			seen[name] = true
		}
	}
	for name := range operationAuthTiers {
		if !seen[name] {
			panic(fmt.Sprintf("api: operationAuthTiers has a stale entry %q with no matching spec operation", name))
		}
	}
}

// adaptMiddleware lifts an ordinary http.Handler middleware into a
// gen.StrictMiddlewareFunc, so the existing, independently unit-tested
// middleware.Session/RequireFamily/RequireSession/RequireAdmin chain gates
// generated strict-server operations too, rather than being reimplemented
// at the (ctx, request) layer strict-server exposes.
//
// The terminal handler captures f's result into resp/err by closure. When mw
// rejects the request — writes directly to w and does not call
// next.ServeHTTP, which is how every middleware in this chain reports a
// rejection — resp/err are left at their zero values. The generated
// strict-server dispatcher (server.gen.go's "response != nil" check after
// every operation) already treats a nil response as "nothing more to
// write", so a rejected request is never written twice.
//
// mw also receives the operationID: adaptMiddleware itself doesn't need it,
// but StrictMiddlewareFunc's shape requires accepting it, and authChain
// below already looked it up before calling here.
func adaptMiddleware(mw func(http.Handler) http.Handler) gen.StrictMiddlewareFunc {
	return func(f gen.StrictHandlerFunc, operationID string) gen.StrictHandlerFunc {
		return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
			var resp any
			var err error
			terminal := http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
				resp, err = f(req.Context(), w, req, request)
			})
			mw(terminal).ServeHTTP(w, r)
			return resp, err
		}
	}
}

// authChain is the one gen.StrictMiddlewareFunc passed to gen.NewStrictHandler:
// it looks up operationID in operationAuthTiers and wraps the call in the
// matching middleware chain (REF §A5's order: APIKeyAuth, Session,
// RequireFamily/RequireSession, RequireAdmin).
func authChain(d Deps) gen.StrictMiddlewareFunc {
	mwDeps := middleware.Deps{Auth: d.Auth, Q: d.Q, RateLimit: d.RateLimit, Now: d.Now}
	apiKey := middleware.APIKeyAuth(mwDeps)
	session := middleware.Session(mwDeps)
	requireSession := middleware.RequireSession()
	family := middleware.RequireFamily(mwDeps)
	admin := middleware.RequireAdmin()
	sysadmin := middleware.RequireSysadmin()
	rejectAPIKey := middleware.RejectAPIKey()
	// Only the two tiers carrying a cookie-writing operation get this; see
	// middleware.CaptureHTTP's doc comment.
	captureHTTP := middleware.CaptureHTTP()

	return func(f gen.StrictHandlerFunc, operationID string) gen.StrictHandlerFunc {
		tier, ok := operationAuthTiers[operationID]
		if !ok {
			// assertOperationAuthCoverage already panicked at NewHandler
			// build time if this were reachable; kept as a loud fallback
			// rather than silently letting the request through.
			panic("api: no authTier for operation " + operationID)
		}

		var chain func(http.Handler) http.Handler
		switch tier {
		case tierPublic:
			return f
		case tierSession:
			chain = func(h http.Handler) http.Handler { return apiKey(session(requireSession(captureHTTP(h)))) }
		case tierFamily:
			chain = func(h http.Handler) http.Handler { return apiKey(session(family(h))) }
		case tierAdmin:
			chain = func(h http.Handler) http.Handler { return apiKey(session(family(admin(h)))) }
		case tierSysadmin:
			chain = func(h http.Handler) http.Handler { return apiKey(session(sysadmin(captureHTTP(h)))) }
		case tierFamilyNoAPIKey:
			chain = func(h http.Handler) http.Handler { return apiKey(session(family(rejectAPIKey(h)))) }
		default:
			panic(fmt.Sprintf("api: unknown authTier %d for operation %q", tier, operationID))
		}
		return adaptMiddleware(chain)(f, operationID)
	}
}

// rateLimitChain is the second gen.StrictMiddlewareFunc passed to
// gen.NewStrictHandlerWithOptions, alongside authChain: the operationID-keyed
// layer that applies the invite endpoints' credential rate limits (REF §A1
// invites.ts's `middleware: [rateLimit(...), rateLimit(...)]` array on
// inviteInfo/redeem — a per-operation middleware list has no equivalent at
// this layer's granularity other than switching on operationID, same as
// authChain does for auth tiers). Every other operationID is untouched.
//
// Listed AFTER authChain in NewHandler's middlewares slice. Per
// gen.StrictServerInterface's generated dispatch (server.gen.go: `for _,
// middleware := range sh.middlewares { handler = middleware(handler, op) }`)
// the LAST entry ends up OUTERMOST — the same fold NewHandler's own
// StdHTTPServerOptions.Middlewares comment documents for the unrelated
// http.Handler-layer slice — so listing this second puts rate limiting
// OUTSIDE the auth chain: a request is charged against its quota before
// RequireSession gets a chance to reject it, matching the TypeScript
// predecessor's behaviour (Hono's route middleware runs before the
// handler's own session check).
//
// One divergence from that predecessor, deliberately not chased: this
// whole StrictMiddlewareFunc layer runs only for requests that reach the
// strict-server dispatch, which is AFTER withSpecValidation
// (NewHandler's outer StdHTTPServerOptions.Middlewares) has already
// rejected anything that fails kin-openapi's request-shape check — so a
// malformed redeem (bad JSON, code over 64 chars) never reaches
// rateLimitChain and is not charged against invite-redeem's quota. Hono's
// route-level middleware array runs ahead of its own zod validation, so
// the TS predecessor charges those attempts. Not worth matching: a
// request that never reaches the handler has no attack value against the
// limiter's purpose (slowing invite-code guessing), only against the
// limiter's own counter — and each endpoint's own global backstop
// (invite-info-global 500/10min, invite-redeem-global 200/10min) already
// covers a flood of those too.
func rateLimitChain(d Deps) gen.StrictMiddlewareFunc {
	inviteInfoIP := middleware.RateLimit(d.RateLimit, "invite-info", 30, 600, false, d.TrustedProxyHops)
	inviteInfoGlobal := middleware.RateLimit(d.RateLimit, "invite-info-global", 500, 600, true, d.TrustedProxyHops)
	inviteRedeemIP := middleware.RateLimit(d.RateLimit, "invite-redeem", 10, 600, false, d.TrustedProxyHops)
	inviteRedeemGlobal := middleware.RateLimit(d.RateLimit, "invite-redeem-global", 200, 600, true, d.TrustedProxyHops)

	return func(f gen.StrictHandlerFunc, operationID string) gen.StrictHandlerFunc {
		var chain func(http.Handler) http.Handler
		switch operationID {
		case "GetInviteInfo":
			chain = func(h http.Handler) http.Handler { return inviteInfoIP(inviteInfoGlobal(h)) }
		case "RedeemInvite":
			chain = func(h http.Handler) http.Handler { return inviteRedeemIP(inviteRedeemGlobal(h)) }
		default:
			return f
		}
		return adaptMiddleware(chain)(f, operationID)
	}
}

// familyChain builds the exact tierFamily chain (apiKeyAuth, then session,
// then family — see authChain's tierFamily case) as a standalone
// http.Handler wrapper, for the hand-routed routes in internal/api/files.go
// that sit outside gen.StrictServerInterface entirely and therefore never
// go through authChain's operationID-keyed dispatch.
func familyChain(d Deps) func(http.Handler) http.Handler {
	mwDeps := middleware.Deps{Auth: d.Auth, Q: d.Q, RateLimit: d.RateLimit, Now: d.Now}
	apiKey := middleware.APIKeyAuth(mwDeps)
	session := middleware.Session(mwDeps)
	family := middleware.RequireFamily(mwDeps)
	return func(h http.Handler) http.Handler { return apiKey(session(family(h))) }
}

// vaccineDocumentsPattern matches /api/vaccines/{id}/documents and anything
// beneath it, one of the spec-validation exclusions below.
var vaccineDocumentsPattern = regexp.MustCompile(`^/api/vaccines/[^/]+/documents(/|$)`)

// skipSpecValidation reports whether r's path is one of the routes that
// never go through kin-openapi request validation: the auth handler (Limen
// owns its own request shapes), raw file streaming, the CSV export stream,
// and vaccine document uploads (multipart, not JSON). /api/auth/ is also
// structurally unreachable here (see NewHandler's mount order) — it is
// listed anyway so this function documents the full exclusion set on its
// own, independent of how the mux happens to be wired today.
func skipSpecValidation(r *http.Request) bool {
	switch {
	case strings.HasPrefix(r.URL.Path, auth.BasePath+"/"):
		return true
	case strings.HasPrefix(r.URL.Path, "/api/files/"):
		return true
	case r.URL.Path == "/api/export.csv":
		return true
	case vaccineDocumentsPattern.MatchString(r.URL.Path):
		return true
	default:
		return false
	}
}

// withSpecValidation validates every /api/ request against spec except the
// paths skipSpecValidation names, returning 400 {"error":"Invalid
// request","code":"VALIDATION"} on failure (REF §A1 item 15).
//
// A request whose path/method matches NO spec operation at all is not a
// validation failure — most of /api/* is not in the spec yet (later tasks
// add it operation by operation) — so it is passed through to next
// untouched, which ends in the JSON 404 below. Only a request that DID match
// a spec operation but failed parameter/body validation gets the 400.
func withSpecValidation(spec *openapi3.T, next http.Handler) http.Handler {
	validate := nethttpmiddleware.OapiRequestValidatorWithOptions(spec, &nethttpmiddleware.Options{
		// The spec's `servers: [{url: /}]` entry is relative (no host) so
		// this would be inert either way; set explicitly so a future spec
		// change that adds an absolute server URL doesn't suddenly start
		// rejecting requests on Host-header mismatch across test/prod.
		DoNotValidateServers: true,
		Skipper:              skipSpecValidation,
		ErrorHandlerWithOpts: func(_ context.Context, _ error, w http.ResponseWriter, r *http.Request, opts nethttpmiddleware.ErrorHandlerOpts) {
			if opts.MatchedRoute == nil {
				next.ServeHTTP(w, r)
				return
			}
			respond.Error(w, http.StatusBadRequest, "Invalid request", "VALIDATION")
		},
	})
	return validate(next)
}

// requireSession resolves the caller and writes the standard envelope on
// failure. It reports whether the caller should continue serving the request.
//
// This is the FULL tenancy check /api/docs and /api/openapi.json get: a
// session must exist, nothing more (no family or role check — those routes
// are documentation, not data). Everything else in /api/* sits behind
// package middleware's chain.
//
// Note for whoever mounts middleware.Session across /api/: both it and this
// resolve the session through SessionFromRequestRefreshing, so a request that
// went through both during a refresh would carry the same Set-Cookie twice.
// Drop this helper in favour of the middleware at that point rather than
// stacking them.
func requireSession(d Deps, w http.ResponseWriter, r *http.Request) bool {
	session, err := d.Auth.SessionFromRequestRefreshing(w, r)
	switch {
	case err != nil:
		respond.Error(w, http.StatusInternalServerError, "session lookup failed", "INTERNAL")
		return false
	case session == nil:
		respond.Error(w, http.StatusUnauthorized, "Not signed in", "UNAUTHENTICATED")
		return false
	default:
		return true
	}
}

// NewHandler builds the /api/* handler: the auth handler (behind the
// credential sign-in rate limit), the session-gated docs routes,
// spec-validated routes for everything else in the spec (currently just
// /healthz and /readyz, mounted here too since the generated router owns
// them), and a JSON 404 for anything unmatched.
//
// The whole thing is wrapped in middleware.TrustedProxy — see the comment at
// the return statement for why that wrapper has to be outermost.
func NewHandler(d Deps) http.Handler {
	spec := loadSpec()
	specJSON, err := spec.MarshalJSON()
	if err != nil {
		// The spec was just validated by loadSpec; a struct that validates
		// but fails to re-marshal would be a kin-openapi bug, not ours.
		panic(fmt.Sprintf("api: marshal embedded spec: %v", err))
	}
	assertOperationAuthCoverage(spec)

	if d.RateLimit == nil {
		// One mistake, one failure mode: middleware.RateLimit panics on a nil
		// store, so a Deps without one must fail here too rather than quietly
		// serving an unlimited sign-in route.
		panic("api: NewHandler needs a rate-limit store")
	}

	mux := http.NewServeMux()

	// The auth handler is mounted directly, never behind spec validation.
	authHandler := d.Auth.Handler()
	mux.Handle(auth.BasePath+"/", authHandler)

	// Credential brute-force brake (REF §A5's rate-limit points): Limen's own
	// limiter is fine, but this one is Postgres-backed and therefore shared
	// across replicas. 20 attempts per 10 minutes per client is generous for
	// a human and hopeless for guessing.
	//
	// Registered as its own, more specific pattern rather than as a wrapper
	// around authHandler: net/http's ServeMux dispatches by specificity, so
	// this claims exactly the credential sign-in POST and every other auth
	// route reaches Limen untouched.
	mux.Handle("POST "+auth.BasePath+"/signin/credential",
		middleware.RateLimit(d.RateLimit, "auth-signin", 20, 600, false, d.TrustedProxyHops)(authHandler))

	mux.HandleFunc("GET /api/openapi.json", func(w http.ResponseWriter, r *http.Request) {
		if !requireSession(d, w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(specJSON)
	})
	mux.HandleFunc("GET /api/docs", func(w http.ResponseWriter, r *http.Request) {
		if !requireSession(d, w, r) {
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(web.ScalarHTML())
	})

	// Hand-routed outside the generated strict server (see internal/api/
	// files.go's package doc comment): multipart bodies and binary
	// streaming responses have no place in the JSON-only route tree
	// oapi-codegen builds gen.StrictServerInterface from. Registered
	// directly on mux, before the least-specific "/api/" pattern below,
	// behind the SAME tierFamily chain (apiKeyAuth, then session, then
	// family) every generated tierFamily operation runs behind —
	// apps/api/src/app.ts's filesApp sits behind the identical "/api/*"
	// apiKeyAuth middleware every other route does, so this port must too.
	d.mountFileRoutes(mux, familyChain(d))

	// CSV export (internal/api/export.go's package doc comment): same
	// reasoning as the files routes above — a text/csv streamed body has
	// no place in the JSON-only strict-server tree — mounted behind the
	// identical familyChain (no admin check, no plan gate, API keys
	// allowed), matching apps/api/src/app.ts's exportApp mount.
	d.mountExportRoutes(mux, familyChain(d))

	if d.ExtraRoutes != nil {
		mwDeps := middleware.Deps{Auth: d.Auth, Q: d.Q, RateLimit: d.RateLimit, Now: d.Now}
		protect := func(h http.Handler) http.Handler {
			return middleware.Session(mwDeps)(middleware.RequireFamily(mwDeps)(h))
		}
		d.ExtraRoutes(mux, protect)
	}

	// Least-specific pattern: catches every /api/* request not claimed by
	// a more specific pattern above (net/http's ServeMux dispatches by
	// pattern specificity, not registration order). Wrapped in spec
	// validation; ends in the JSON 404 for anything the spec — and
	// therefore the generated routes below — doesn't recognise.
	mux.Handle("/api/", withSpecValidation(spec, http.HandlerFunc(handleAPINotFound)))

	// Registers every generated operation on mux: GET /healthz and GET
	// /readyz (top-level, outside /api/, per REF §A1) plus, from Task 9
	// on, every /api/ operation in the spec. See this package's doc
	// comment for the two-layer wrapping below (spec validation, then
	// auth) and why each lives at the generated-code layer it does.
	//
	// NewStrictHandlerWithOptions (not the plain NewStrictHandler) so both
	// error paths the generated strict-server machinery can hit answer
	// with the standard {"error","code"} envelope instead of
	// oapi-codegen's own default (http.Error(w, err.Error(), status): a
	// text/plain body with the raw Go error string — a request-decode
	// failure OR a handler method returning (nil, err) would otherwise
	// leak internals (e.g. a raw pgx error) straight to the client).
	strictHandler := gen.NewStrictHandlerWithOptions(
		d,
		[]gen.StrictMiddlewareFunc{authChain(d), rateLimitChain(d)},
		gen.StrictHTTPServerOptions{
			RequestErrorHandlerFunc:  requestErrorHandler,
			ResponseErrorHandlerFunc: responseErrorHandler,
		},
	)
	gen.HandlerWithOptions(strictHandler, gen.StdHTTPServerOptions{
		BaseRouter: mux,
		// Order matters: ServerInterfaceWrapper (server.gen.go) builds
		// handler := base then, for each entry here in order, handler =
		// entry(handler) — so the LAST entry ends up OUTERMOST (runs
		// first) and the FIRST entry innermost (runs last, right before
		// the strict handler's own body decode). withRawBody must run
		// before anything else touches the body, so it is listed last.
		// See patch.go's package doc comment for why it exists.
		Middlewares: []gen.MiddlewareFunc{
			func(next http.Handler) http.Handler { return withSpecValidation(spec, next) },
			withRawBody,
		},
	})

	// Outermost, deliberately. net/http sets RemoteAddr from the socket
	// before ANY handler runs, so the proxy-hop rewrite has to wrap the
	// handler this function RETURNS rather than sit at one of the mount
	// points above: Limen's own sign-in limiter and its session client-address
	// digest read RemoteAddr, and behind an ingress an untranslated address
	// collapses both into one shared bucket. With TRUSTED_PROXY_HOPS at its
	// default 0 the wrapper is a no-op and returns the mux unchanged.
	return middleware.TrustedProxy(d.TrustedProxyHops)(mux)
}

// handleAPINotFound is the terminal handler for any /api/* request no
// earlier pattern claimed.
func handleAPINotFound(w http.ResponseWriter, _ *http.Request) {
	respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
}

// responseErrorHandler is gen.StrictHTTPServerOptions.ResponseErrorHandlerFunc:
// reached whenever a gen.StrictServerInterface method (every operation in
// babies.go, me.go, and every future route file) returns a non-nil error —
// almost always a database failure, since a handler returns a typed
// ResponseObject for every condition its own logic anticipates (404, 403,
// …) and only reaches for a plain error on the ones it doesn't. The real
// error is logged server-side; the client gets the same
// {"error":"Internal error","code":"INTERNAL"} envelope every other
// unexpected-failure path in this file uses (see requireSession above), not
// oapi-codegen's default text/plain err.Error() — which would leak
// internals (e.g. a raw pgx error naming a table or column) straight to the
// caller.
func responseErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("api: %s %s: %v", r.Method, r.URL.Path, err)
	respond.Error(w, http.StatusInternalServerError, "Internal error", "INTERNAL")
}

// requestErrorHandler is gen.StrictHTTPServerOptions.RequestErrorHandlerFunc:
// reached when a strict-server method's own json.Decode of the request body
// fails. In the normal case this is unreachable — withSpecValidation (wired
// as this handler's outer Middlewares layer, see NewHandler) already
// rejects a body that fails to parse as JSON, or that parses but violates
// the spec's schema, before the strict handler's decode ever runs — but a
// body that parses as JSON, passes kin-openapi's schema check, and still
// fails Go's stricter decode (e.g. a numeric field kin-openapi's laxer
// checking let through as a bool) is possible in principle. Answers with
// the SAME envelope withSpecValidation's ErrorHandlerWithOpts uses, so a
// caller can't tell which of the two layers caught its malformed request.
func requestErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("api: %s %s: invalid request: %v", r.Method, r.URL.Path, err)
	respond.Error(w, http.StatusBadRequest, "Invalid request", "VALIDATION")
}
