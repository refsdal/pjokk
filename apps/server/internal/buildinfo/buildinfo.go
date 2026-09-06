// Package buildinfo is the ONE place the running binary's version lives.
//
// Version is stamped at link time (-X …/buildinfo.Version=<v>) by
// .goreleaser.yaml for releases and by scripts/build-artifacts.sh
// (PJOKK_VERSION) for the CI preview image; a plain `go build` leaves it
// at "dev". The string is deliberately the SAME one the image is tagged
// with — "0.8.0" for a release, "0.9.0-pr.42.abc1234" for a PR preview —
// so that everything that names a version names this one:
//
//   - the container image tag (GoReleaser's {{ .Version }}),
//   - the Settings footer, via /api/me (internal/api.Deps.Version),
//   - the boot log line,
//   - the OpenTelemetry resource's service.version, when tracing lands.
//
// Consumers receive it through Deps or read it here from a composition
// root; nothing derives a version from anywhere else (no package.json, no
// git describe at runtime, no Vite define), because a second source is a
// second thing to drift.
package buildinfo

// Version is the build version, or "dev" when not stamped.
var Version = "dev"
