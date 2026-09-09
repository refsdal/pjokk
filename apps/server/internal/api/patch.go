package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
//  2. patchBody + patchField turn those captured bytes into presence
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
// patchBody's map[string]json.RawMessage decode to work with regardless.
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

// patchSet is one PATCH request's decoded body, plus the two answers every
// handler needs from it after reading its fields: did anything fail to
// decode, and was any field present at all.
//
// It exists because the alternative — which is what this package did until
// now — is three lines of error handling per field:
//
//	xSet, xVal, err := patchField[T](fields, "x")
//	if err != nil {
//		return nil, err
//	}
//
// times eleven fields in UpdateFeed, plus a hand-written
// `!aSet && !bSet && …` chain that has to be extended by hand every time a
// column is added. Collecting the first error instead — the same shape
// internal/config's problemCollector uses for the same reason — makes the
// per-field line a single assignment and the empty-patch check a method
// call that cannot fall out of step with the fields above it.
type patchSet struct {
	fields map[string]json.RawMessage
	// err is the FIRST decode failure; later ones are dropped, since the
	// handler abandons the request on any of them.
	err error
	// touched records whether any field a handler ASKED FOR was present.
	// Not "the body was non-empty": a body carrying only keys this
	// operation does not read must still count as an empty patch, exactly
	// as the `!aSet && !bSet && …` chains it replaces did.
	touched bool
}

// patchBody decodes the body withRawBody captured into a patchSet, keyed by
// JSON field name — a plain Go map already distinguishes the three states a
// PATCH body's nullable-optional field can be in: a missing key means
// "omitted" (patchField's `set` comes back false), a key whose raw value is
// the literal `null` means "explicit clear" (`set` true, value nil),
// anything else means "set to this value" (`set` true, value non-nil).
//
// operation names the caller for the empty-body error, which is
// impossible-in-practice — spec validation rejects a PATCH with no body
// well before this — but is reported rather than assumed away, mirroring
// CreateBaby/UpdateBaby's convention.
func patchBody(ctx context.Context, operation string) (*patchSet, error) {
	raw, _ := ctx.Value(rawBodyCtxKey{}).([]byte)
	if len(raw) == 0 {
		return nil, errNoRequestBody(operation)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return &patchSet{fields: m}, nil
}

// patchField reports whether key is present in p and, if so, decodes its
// value into a *T: nil when the JSON value was the literal `null` (an
// explicit clear), non-nil otherwise. An absent key reports set=false and a
// nil value, meaning "leave the column alone" — the caller must not read
// anything into that as a clear.
//
// A value that fails to decode is latched on p (see Err) and reported as
// ABSENT, so a handler that forgot its Err check leaves the column alone
// rather than clearing it. Reaching that at all takes a body that parses as
// JSON, satisfies the operation's OpenAPI schema, and still fails Go's
// stricter decode — see requestErrorHandler in api.go, which documents the
// same near-impossible gap one layer up.
//
// A free function rather than a method because Go methods cannot take type
// parameters.
func patchField[T any](p *patchSet, key string) (set bool, value *T) {
	raw, ok := p.fields[key]
	if !ok {
		return false, nil
	}
	if string(raw) == "null" {
		p.touched = true
		return true, nil
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		if p.err == nil {
			p.err = fmt.Errorf("api: patch field %q: %w", key, err)
		}
		return false, nil
	}
	p.touched = true
	return true, &v
}

// Err reports the first field that failed to decode, or nil. Every handler
// must check it after reading its fields and before acting on them.
func (p *patchSet) Err() error { return p.err }

// Any reports whether at least one field the handler read was present —
// the empty-patch test. A patch with no fields at all is a no-op that
// re-reads and returns the row unchanged, matching scoped.ts's compactPatch.
func (p *patchSet) Any() bool { return p.touched }
