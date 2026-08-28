// Computes the next semantic version from Conventional Commits.
//
//   bun scripts/next-version.mjs             # print the decision
//   bun scripts/next-version.mjs --json      # machine-readable
//
// The source of truth for "current version" is the latest `v*.*.*` git TAG,
// not package.json — package.json is private and unpublished, so keeping a
// version in it would be a second thing to forget to update. With no tags at
// all, the first release starts from 0.0.0.
//
// Rules (CLAUDE.md mandates Conventional Commits, so this is enforceable):
//   feat!: / BREAKING CHANGE: footer  → major
//   feat:                             → minor
//   fix: / perf:                      → patch
//   anything else                     → no bump on its own
//
// Pre-1.0 guard: while the major version is 0 the API is by definition
// unstable, so a breaking change bumps the MINOR rather than declaring 1.0.
// Going to 1.0 should be a decision someone makes, not something a commit
// message does by accident. Pass --allow-major to override.

import { $ } from "bun";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const allowMajor = args.includes("--allow-major");

/** Latest v-prefixed tag by semver order, or null when the repo has none. */
async function latestTag() {
  const out = await $`git tag --list "v*.*.*" --sort=-v:refname`
    .quiet()
    .nothrow();
  const first = out.stdout.toString().split("\n").find(Boolean);
  return first?.trim() ?? null;
}

function parseVersion(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? "");
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

const tag = await latestTag();
const current = parseVersion(tag);

// %B is the full message (subject + body), so BREAKING CHANGE footers are
// visible. \x00 separates records: commit bodies contain blank lines.
const range = tag ? `${tag}..HEAD` : "HEAD";
const raw = await $`git log ${range} --pretty=format:%B%x00`.quiet().nothrow();
const commits = raw.stdout
  .toString()
  .split("\0")
  .map((c) => c.trim())
  .filter(Boolean);

const HEADER =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<subject>.+)$/;

let bump = null; // "major" | "minor" | "patch" | null
const reasons = [];
const rank = { patch: 1, minor: 2, major: 3 };
const raise = (level, why) => {
  if (!bump || rank[level] > rank[bump]) bump = level;
  reasons.push(`${level}: ${why}`);
};

for (const commit of commits) {
  const [subject = "", ...rest] = commit.split("\n");
  const body = rest.join("\n");
  const m = HEADER.exec(subject.trim());
  if (!m?.groups) continue;
  const { type, bang } = m.groups;

  if (bang || /^BREAKING[ -]CHANGE:/m.test(body)) {
    raise("major", subject.trim());
    continue;
  }
  if (type === "feat") raise("minor", subject.trim());
  else if (type === "fix" || type === "perf") raise("patch", subject.trim());
}

let next = { ...current };
let effective = bump;

if (bump === "major" && current.major === 0 && !allowMajor) {
  // Pre-1.0 guard, see the header comment.
  effective = "minor";
  reasons.push(
    "note: breaking change downgraded to minor because the major version is 0 (pass --allow-major to release 1.0.0)",
  );
}

if (effective === "major")
  next = { major: current.major + 1, minor: 0, patch: 0 };
else if (effective === "minor")
  next = { ...current, minor: current.minor + 1, patch: 0 };
else if (effective === "patch") next = { ...current, patch: current.patch + 1 };

const version = `${next.major}.${next.minor}.${next.patch}`;
const result = {
  previousTag: tag,
  previousVersion: `${current.major}.${current.minor}.${current.patch}`,
  bump: effective,
  version,
  tag: `v${version}`,
  commits: commits.length,
  reasons,
  // Nothing to release is a legitimate outcome — docs-only work, say.
  releasable: effective !== null,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`previous tag : ${tag ?? "(none)"}`);
  console.log(`commits       : ${commits.length}`);
  console.log(`bump          : ${effective ?? "none"}`);
  console.log(`next version  : ${result.tag}`);
  if (reasons.length) {
    console.log("why:");
    for (const r of reasons.slice(0, 12)) console.log(`  ${r}`);
    if (reasons.length > 12) console.log(`  … and ${reasons.length - 12} more`);
  }
}

// GitHub Actions consumes these. APPENDED, not written: GITHUB_OUTPUT is a
// file the whole step shares, so overwriting it would discard anything
// another command in the same step had already put there.
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("node:fs");
  const lines = [
    `version=${result.version}`,
    `tag=${result.tag}`,
    `bump=${effective ?? ""}`,
    `releasable=${result.releasable}`,
    `previous_tag=${tag ?? ""}`,
  ].join("\n");
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
}
