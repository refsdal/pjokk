// Command go generate regenerates the OpenAPI-derived code in
// internal/api/gen from openapi/pjokk.yaml (repo root). Run from
// apps/server:
//
//	export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH
//	go generate ./...
//
// oapi-codegen v2.8.0 (github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen)
// must be on PATH. Generated code is committed — the container image and CI
// do not run codegen at build time.
package server

// internal/api/pjokk.yaml is a committed COPY of the repo-root spec, kept in
// sync by this generate step: go:embed cannot reach outside a package's own
// directory tree, and openapi/ sits above the module root, so the API
// package (which serves the embedded spec at /api/openapi.json and feeds it
// to the request-validation middleware) needs its own copy to embed.
// openapi/pjokk.yaml stays the single source of truth; never hand-edit the
// copy.
//go:generate cp ../../openapi/pjokk.yaml internal/api/pjokk.yaml
//go:generate oapi-codegen -config internal/api/gen/cfg-types.yaml ../../openapi/pjokk.yaml
//go:generate oapi-codegen -config internal/api/gen/cfg-server.yaml ../../openapi/pjokk.yaml
