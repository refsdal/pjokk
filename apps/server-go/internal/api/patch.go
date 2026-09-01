package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
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

// withRawBody reads r.Body fully (if any), stashes the bytes in the request
// context under rawBodyCtxKey, and restores r.Body to a fresh reader over
// the same bytes. A read failure is not fatal here — it leaves the context
// value unset, and a PATCH handler that needed it treats a missing capture
// the same as an impossible-in-practice nil body (errNoRequestBody); the
// normal request-decode paths (spec validation, the strict handler's own
// Decode) still get a chance to fail more specifically first, since this
// middleware never itself rejects a request.
func withRawBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody {
			raw, err := io.ReadAll(r.Body)
			_ = r.Body.Close()
			if err == nil {
				r.Body = io.NopCloser(bytes.NewReader(raw))
				r = r.WithContext(context.WithValue(r.Context(), rawBodyCtxKey{}, raw))
			}
		}
		next.ServeHTTP(w, r)
	})
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
