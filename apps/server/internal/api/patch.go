package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/refsdal/pjokk/server/internal/api/respond"
)

// This file is the PATCH tri-state pattern established by Task 10
// (feeds.go/diapers.go) for every future log-route PATCH (sleep,
// other-logs, play, …). See feeds.go's package doc comment for the full
// rationale; this file is just the mechanics two things need:
//
//  1. withRawBody (wired into NewHandler's Middlewares, see api.go) captures
//     the original request body bytes into the request context before
//     anything downstream — kin-openapi's spec validation, then the
//     generated strict-server's own json.Decode — consumes r.Body, and
//     replaces r.Body with a fresh reader over the same bytes so every
//     later stage still sees a normal, once-only-readable body.
//  2. rawBodyFields + patchField turn those captured bytes into presence
//     information a PATCH handler can act on: for each JSON field, was it
//     omitted, sent as `null`, or sent with a value?

// rawBodyCtxKey is this package's context key for the captured body bytes.
type rawBodyCtxKey struct{}

// maxJSONBodyBytes bounds how much of a request body withRawBody will
// buffer into memory. Every operation on the strict mux takes small,
// OpenAPI-bounded JSON — the largest today is a handful of string/int
// fields — so 1 MiB is generous headroom for that shape while still being
// a hard structural cap, not just a comment, against double-buffering an
// uncapped body if a future route on THIS mux ever takes a large payload.
//
// The vaccine-documents upload route (images/PDF, 10 MiB, multipart) does
// NOT belong here and never will: it is registered directly on NewHandler's
// mux (see skipSpecValidation's vaccineDocumentsPattern), outside
// gen.HandlerWithOptions entirely, so it never passes through
// ServerInterfaceWrapper's HandlerMiddlewares — and therefore never through
// withRawBody — at all. Its own cap lives wherever that handler is written.
const maxJSONBodyBytes = 1 << 20 // 1 MiB

// withRawBody reads r.Body fully (if hasJSONBody says there's one worth
// reading — see its doc comment), stashes the bytes in the request context
// under rawBodyCtxKey, and restores r.Body to a fresh reader over the same
// bytes.
//
// The read is capped at maxJSONBodyBytes via http.MaxBytesReader: a body
// over the cap is rejected here with 413 {"error":"Request body too
// large","code":"TOO_LARGE"} rather than being read to completion (or
// exhausting memory) — chosen over reusing 400 VALIDATION because
// "malformed JSON" and "too much JSON" are different failure classes worth
// distinguishing on the wire, and 413 is the standard HTTP status for
// exactly this condition.
//
// Any OTHER read failure (client hung up mid-body, etc.) is not treated as
// fatal here — the context value is simply left unset, and a PATCH handler
// that needed it treats a missing capture the same as an
// impossible-in-practice nil body (errNoRequestBody); the normal
// request-decode paths (spec validation, the strict handler's own Decode)
// still get a chance to fail more specifically first, since this
// middleware never itself rejects a request for reasons other than size.
func withRawBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hasJSONBody(r) {
			next.ServeHTTP(w, r)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
		raw, err := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				respond.Error(w, http.StatusRequestEntityTooLarge, "Request body too large", "TOO_LARGE")
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		r.Body = io.NopCloser(bytes.NewReader(raw))
		r = r.WithContext(context.WithValue(r.Context(), rawBodyCtxKey{}, raw))
		next.ServeHTTP(w, r)
	})
}

// hasJSONBody reports whether r is a request withRawBody should bother
// buffering at all: GET/HEAD/DELETE carry no body semantics anywhere in
// this API (every route reads those methods' inputs from query/path
// params), and a request whose Content-Type isn't JSON has nothing for
// rawBodyFields' map[string]json.RawMessage decode to work with regardless.
// Gating on both keeps this middleware's cost — and its size cap's
// relevance — scoped to the JSON POST/PATCH bodies it exists for, so a
// future non-JSON route added to this SAME mux (unlike vaccine documents,
// which is deliberately kept off it — see maxJSONBodyBytes) could never be
// silently double-buffered by this middleware without a second thought.
func hasJSONBody(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodDelete:
		return false
	}
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return false
	}
	return mt == "application/json"
}

// rawBodyFields decodes the body withRawBody captured into a map keyed by
// JSON field name — a plain Go map already distinguishes the three states a
// PATCH body's nullable-optional field can be in: a missing key means
// "omitted" (patchField's `present` comes back false), a key whose raw
// value is the literal `null` means "explicit clear" (`present` true,
// `value` nil), anything else means "set to this value" (`present` true,
// `value` non-nil). Returns (nil, nil) when withRawBody never ran or the
// body was empty; callers treat that as errNoRequestBody, mirroring
// CreateBaby/UpdateBaby's convention for an impossible-in-practice empty
// body (spec validation already rejects a PATCH with no body before this
// can be reached in practice).
func rawBodyFields(ctx context.Context) (map[string]json.RawMessage, error) {
	raw, _ := ctx.Value(rawBodyCtxKey{}).([]byte)
	if len(raw) == 0 {
		return nil, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// patchField reports whether key is present in fields and, if so, decodes
// its value into a *T: nil when the JSON value was the literal `null` (an
// explicit clear), non-nil otherwise. An absent key reports present=false
// and a nil value, meaning "leave the column alone" — the caller must not
// read anything into that as a clear.
//
// By the time a handler calls this, kin-openapi's spec validation has
// already checked the raw body against the operation's schema (see
// withRawBody's doc comment on ordering), so a value present here is
// already known to satisfy whatever type/bounds/enum the OpenAPI schema
// declared for it — this function only needs to decode it into the target
// Go type, not re-validate it.
func patchField[T any](fields map[string]json.RawMessage, key string) (present bool, value *T, err error) {
	raw, ok := fields[key]
	if !ok {
		return false, nil, nil
	}
	if string(raw) == "null" {
		return true, nil, nil
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, nil, err
	}
	return true, &v, nil
}
