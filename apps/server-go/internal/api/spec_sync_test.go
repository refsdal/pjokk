package api_test

import (
	"bytes"
	"os"
	"testing"
)

// TestEmbeddedSpecMatchesRepoRoot guards the copy generate.go's `cp` step
// produces (internal/api/pjokk.yaml, embedded at build time and served at
// /api/openapi.json) against drifting from the single source of truth
// (repo-root openapi/pjokk.yaml). Nothing else catches this: go:embed
// happily embeds a stale copy, and the embedded file compiles either way.
//
// `go test` runs with the package's source directory as its working
// directory, so both paths below are relative to
// apps/server-go/internal/api.
func TestEmbeddedSpecMatchesRepoRoot(t *testing.T) {
	embedded, err := os.ReadFile("pjokk.yaml")
	if err != nil {
		t.Fatalf("read embedded copy (internal/api/pjokk.yaml): %v", err)
	}

	root, err := os.ReadFile("../../../../openapi/pjokk.yaml")
	if err != nil {
		t.Fatalf("read repo-root spec (openapi/pjokk.yaml): %v", err)
	}

	if !bytes.Equal(embedded, root) {
		t.Fatalf("internal/api/pjokk.yaml has drifted from openapi/pjokk.yaml — " +
			"run `go generate ./...` from apps/server-go to resync the embedded copy, " +
			"then commit the result")
	}
}
