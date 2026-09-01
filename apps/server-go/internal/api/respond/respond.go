// Package respond holds the JSON error envelope every hand-written HTTP
// response in this server uses: `{"error": "...", "code": "..."}` (REF §A1,
// CLAUDE.md).
//
// It is its own package rather than a file inside internal/api because the
// middleware chain writes the same envelope and internal/api imports the
// middleware to build the handler — a helper living in internal/api would
// make that an import cycle. Nothing here knows about routing, so both sides
// can depend on it.
package respond

import (
	"encoding/json"
	"net/http"
)

// Issue is one entry of the error envelope's optional `issues` array: the
// frontend only reads error/code today, and issues exist for a more specific
// future UI.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Envelope is the `{error, code}` shape used by every non-2xx JSON response
// written by hand (as opposed to the generated strict-server responses, which
// encode their own success bodies).
type Envelope struct {
	Error  string  `json:"error"`
	Code   string  `json:"code"`
	Issues []Issue `json:"issues,omitempty"`
}

// JSON encodes v as the response body with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes the standard error envelope.
func Error(w http.ResponseWriter, status int, message, code string) {
	JSON(w, status, Envelope{Error: message, Code: code})
}
