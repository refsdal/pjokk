# DECISIONS

Decisions made during implementation that CLAUDE.md does not cover. Boring
choices, noted so they can be revisited deliberately.

- **Work happens on `main`.** Zero-commit greenfield repo whose sole purpose is
  this build; branching would be ceremony.
- **Package manager: pnpm.** (Environment note: npm is not installed on this
  machine; pnpm is invoked via a corepack-downloaded binary.)
- **TanStack Router in code-based mode** (no file-based route generation) —
  fewer moving parts, no codegen watcher, same type safety at this scale.
- **shadcn/ui components are hand-vendored**, not pulled via the CLI registry
  (shadcn is vendored-code-by-design; the CLI is interactive and adds churn).
  Same idiom: cva + tailwind-merge + Radix where needed.
