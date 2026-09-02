# Contributing

Thanks for considering it. Pjokk is a small, opinionated project — reading
this first will save you a rejected PR.

## Ground rules

- **Discuss features before building them.** Open an issue first; Pjokk is
  deliberately calm and small (see the product principles in
  [CLAUDE.md](CLAUDE.md) — it doubles as the contributor deep-dive).
  Bug fixes can go straight to a PR.
- **Conventional Commits are load-bearing.** `feat:`/`fix:`/`perf:` bump
  the version and write the changelog; merging to main releases
  automatically. A mislabeled commit ships a mislabeled release.
- **Generated code is committed.** After touching `openapi/pjokk.yaml` or
  `apps/server/internal/db/queries/*.sql`, run `go generate ./...` (from
  `apps/server`) and `bun run gen:client`, and commit the output — a
  drift-guard test fails otherwise.

## Getting set up

```sh
mise install                                       # pinned Go, Bun + codegen tools
bun install
docker compose -f docker-compose.test.yml up -d    # Postgres for tests + dev

mise run test     # the full suite: Go against real Postgres + frontend/landing
mise run check    # lint, typecheck, i18n coverage, goreleaser config
mise run e2e      # Playwright against the real container image (needs Docker;
                  # first run: `bunx playwright install --with-deps chromium`)
```

Run the app locally: `cd apps/server && go run ./cmd/pjokk` (needs the env
documented in [.env.example](.env.example); `OPEN_SIGNUP=1` bootstraps your
first account) and `bun run dev` for the SPA.

Notes that bite people:

- Go tests must run `-p 1` (packages share one database); `mise run test`
  does this for you.
- Tests run against a **real Postgres**, never a mock — that is the point.
- The container image is COPY-only: `bash scripts/build-artifacts.sh`
  before `docker build .`.

## Pull requests

CI runs the full suite, smoke-tests the container, and pushes a preview
image (`ghcr.io/refsdal/pjokk:<next>-pr.<number>`) you can run. Keep PRs
small and scoped; every commit should compile and pass tests on its own.

Security issues: **not** via issues or PRs — see [SECURITY.md](SECURITY.md).
