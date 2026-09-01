package api

import (
	"encoding/json"
	"net/http"
)

// issue is one entry of the error envelope's optional `issues` array
// (CLAUDE.md / REF §A1: the frontend only reads error/code today; issues
// exist for a more specific future UI).
type issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// errorEnvelope is the `{error, code}` shape used by every non-2xx JSON
// response this package writes by hand (as opposed to the generated
// strict-server responses, which encode their own success bodies).
type errorEnvelope struct {
	Error  string  `json:"error"`
	Code   string  `json:"code"`
	Issues []issue `json:"issues,omitempty"`
}

// writeJSON encodes v as the response body with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes the standard error envelope.
func writeError(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, errorEnvelope{Error: message, Code: code})
}
