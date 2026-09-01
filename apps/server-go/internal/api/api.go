// Package api is the HTTP surface's composition point: it builds the
// /api/* handler from Deps (the collaborators the composition root in
// apps/server-go/cmd/pjokk assembles) and the generated OpenAPI-derived
// server code in internal/api/gen.
//
// package web wraps whatever NewHandler returns with static asset serving
// and REF §A9's headers; api.NewHandler itself is only ever reached for
// /api/* requests (see web.Handler's routing).
package api

import (
	"context"
	_ "embed"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/jackc/pgx/v5/pgxpool"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/auth"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/web"
)

// Deps is every collaborator the API layer needs, assembled by the
// composition root (apps/server, née; here apps/server-go/cmd/pjokk) and
// never constructed by this package itself (CLAUDE.md's Deps discipline,
// carried over from apps/api).
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
			writeError(w, http.StatusBadRequest, "Invalid request", "VALIDATION")
		},
	})
	return validate(next)
}

// requireSession runs auth.Service.SessionFromRequest and writes the
// standard envelope on failure. It reports whether the caller should
// continue serving the request.
//
// This is the FULL tenancy check /api/docs and /api/openapi.json get in
// this task: a session must exist, nothing more (no family/role check —
// Task 6 builds that middleware for the rest of /api/*).
func requireSession(d Deps, w http.ResponseWriter, r *http.Request) bool {
	session, err := d.Auth.SessionFromRequest(r)
	switch {
	case err != nil:
		writeError(w, http.StatusInternalServerError, "session lookup failed", "INTERNAL")
		return false
	case session == nil:
		writeError(w, http.StatusUnauthorized, "Authentication required", "UNAUTHENTICATED")
		return false
	default:
		return true
	}
}

// NewHandler builds the /api/* handler: the auth handler, the session-gated
// docs routes, spec-validated routes for everything else in the spec
// (currently just /healthz and /readyz, mounted here too since the
// generated router owns them), and a JSON 404 for anything unmatched.
func NewHandler(d Deps) http.Handler {
	spec := loadSpec()
	specJSON, err := spec.MarshalJSON()
	if err != nil {
		// The spec was just validated by loadSpec; a struct that validates
		// but fails to re-marshal would be a kin-openapi bug, not ours.
		panic(fmt.Sprintf("api: marshal embedded spec: %v", err))
	}

	mux := http.NewServeMux()

	// The auth handler is mounted directly, never behind spec validation.
	//
	// A future middleware that must see EVERY request before Limen does —
	// proxy-hop RemoteAddr rewriting (Task 6), which Limen's rate limiter
	// and session IP digest both depend on via net/http's r.RemoteAddr —
	// has to wrap the http.Handler this function RETURNS, not be inserted
	// at this mount point: net/http sets RemoteAddr on the request before
	// ANY handler runs, this one included, so wrapping only the mux here
	// would still leave Limen reading the untranslated address.
	mux.Handle(auth.BasePath+"/", d.Auth.Handler())

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

	// Least-specific pattern: catches every /api/* request not claimed by
	// a more specific pattern above (net/http's ServeMux dispatches by
	// pattern specificity, not registration order). Wrapped in spec
	// validation; ends in the JSON 404 for anything the spec — and
	// therefore the generated routes below — doesn't recognise.
	mux.Handle("/api/", withSpecValidation(spec, http.HandlerFunc(handleAPINotFound)))

	// Registers GET /healthz and GET /readyz directly on mux (both are
	// top-level paths, outside /api/, per REF §A1).
	strictHandler := gen.NewStrictHandler(d, nil)
	gen.HandlerWithOptions(strictHandler, gen.StdHTTPServerOptions{BaseRouter: mux})

	return mux
}

// handleAPINotFound is the terminal handler for any /api/* request no
// earlier pattern claimed.
func handleAPINotFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "Not found", "NOT_FOUND")
}
