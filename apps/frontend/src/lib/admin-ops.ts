import type { components } from "@/lib/api-schema";

// The operator console's Ops tab (spec 2026-09-11-admin-ops §2, §4): the
// view logic that can be got wrong silently, kept out of the screens.

export type AdminOps = components["schemas"]["AdminOps"];
export type AdminOpsJob = components["schemas"]["AdminJob"];
export type AdminJobRun = components["schemas"]["AdminJobRun"];
export type AdminBackups = components["schemas"]["AdminBackups"];

// The one line Overview shows. A code rather than a sentence, so the screen
// words it through t() — this file is not under screens/admin/, where the
// i18n check stops looking.
export type OpsSummary =
  | { kind: "healthy" }
  | { kind: "schema-behind" }
  | { kind: "schema-ahead" }
  | { kind: "failed"; job: string; at: string }
  | { kind: "interrupted"; job: string }
  | { kind: "never-run"; job: string }
  | { kind: "stale"; job: string };

// The first problem worth an operator's attention, most serious first: a
// schema out of step with the build, then a job whose newest run failed or
// died, then a job that has not succeeded recently (or ever). A run in
// progress is not a problem.
export function opsSummary(ops: AdminOps): OpsSummary {
  if (ops.schema.applied < ops.schema.latest) return { kind: "schema-behind" };
  if (ops.schema.applied > ops.schema.latest) return { kind: "schema-ahead" };
  for (const job of ops.jobs) {
    const last = job.runs[0];
    if (last?.status === "failed") {
      return {
        kind: "failed",
        job: job.name,
        at: last.finishedAt ?? last.startedAt,
      };
    }
    if (last?.status === "interrupted") {
      return { kind: "interrupted", job: job.name };
    }
  }
  for (const job of ops.jobs) {
    if (!job.stale) continue;
    return job.lastSuccessAt
      ? { kind: "stale", job: job.name }
      : { kind: "never-run", job: job.name };
  }
  return { kind: "healthy" };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

// Binary units, one decimal below ten ("1.5 KB", "10 MB").
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown =
    unit === 0 || value >= 10
      ? String(Math.round(value))
      : value.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${UNITS[unit]}`;
}
