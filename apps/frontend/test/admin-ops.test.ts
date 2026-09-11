import { describe, expect, it } from "bun:test";
import {
  type AdminOps,
  type AdminOpsJob,
  formatBytes,
  opsSummary,
} from "../src/lib/admin-ops";

// The Ops tab's view logic (spec 2026-09-11-admin-ops §2, §4): the one line
// Overview shows, and byte sizes for the backup list.

function job(over: Partial<AdminOpsJob> = {}): AdminOpsJob {
  return {
    name: "nightly",
    schedule: "15 3 * * *",
    nextDue: "2026-03-02T03:15:00Z",
    lastSuccessAt: "2026-03-01T03:16:00Z",
    stale: false,
    running: false,
    runs: [
      {
        id: "r1",
        trigger: "schedule",
        startedAt: "2026-03-01T03:15:00Z",
        finishedAt: "2026-03-01T03:16:00Z",
        status: "ok",
      },
    ],
    ...over,
  };
}

function ops(over: Partial<AdminOps> = {}): AdminOps {
  return {
    version: "0.9.0",
    schema: { applied: 15, latest: 15 },
    storage: { driver: "fs", path: "/data" },
    database: { sizeBytes: 1024, serverVersion: "17.2" },
    jobs: [job(), job({ name: "frequent", schedule: "*/15 * * * *" })],
    ...over,
  };
}

describe("opsSummary", () => {
  it("is healthy when the schema matches and every job is fresh", () => {
    expect(opsSummary(ops())).toEqual({ kind: "healthy" });
  });

  it("names a schema the database has not caught up with first", () => {
    const o = ops({ schema: { applied: 14, latest: 15 } });
    o.jobs[0] = job({ stale: true });
    expect(opsSummary(o)).toEqual({ kind: "schema-behind" });
  });

  it("names a database newer than this build", () => {
    expect(opsSummary(ops({ schema: { applied: 16, latest: 15 } }))).toEqual({
      kind: "schema-ahead",
    });
  });

  it("names a job whose newest run failed, with when", () => {
    const o = ops();
    o.jobs[1] = job({
      name: "frequent",
      runs: [
        {
          id: "r2",
          trigger: "schedule",
          startedAt: "2026-03-01T11:45:00Z",
          finishedAt: "2026-03-01T11:46:00Z",
          status: "failed",
          error: "push service down",
        },
      ],
    });
    expect(opsSummary(o)).toEqual({
      kind: "failed",
      job: "frequent",
      at: "2026-03-01T11:46:00Z",
    });
  });

  it("names an interrupted run", () => {
    const o = ops();
    o.jobs[0] = job({
      runs: [
        {
          id: "r3",
          trigger: "console",
          startedAt: "2026-03-01T01:00:00Z",
          status: "interrupted",
        },
      ],
    });
    expect(opsSummary(o)).toEqual({ kind: "interrupted", job: "nightly" });
  });

  it("puts a failure ahead of a stale job", () => {
    const o = ops();
    o.jobs[0] = job({ stale: true });
    o.jobs[1] = job({
      name: "frequent",
      runs: [
        {
          id: "r4",
          trigger: "schedule",
          startedAt: "2026-03-01T11:45:00Z",
          finishedAt: "2026-03-01T11:46:00Z",
          status: "failed",
        },
      ],
    });
    expect(opsSummary(o).kind).toBe("failed");
  });

  it("tells a job that has never run from one that has gone stale", () => {
    const never = ops();
    never.jobs[1] = job({
      name: "frequent",
      stale: true,
      lastSuccessAt: undefined,
      runs: [],
    });
    expect(opsSummary(never)).toEqual({ kind: "never-run", job: "frequent" });

    const stale = ops();
    stale.jobs[0] = job({ stale: true });
    expect(opsSummary(stale)).toEqual({ kind: "stale", job: "nightly" });
  });

  it("does not count a run in progress as a problem", () => {
    const o = ops();
    o.jobs[0] = job({
      running: true,
      runs: [
        {
          id: "r5",
          trigger: "console",
          startedAt: "2026-03-01T12:00:00Z",
          status: "running",
        },
      ],
    });
    expect(opsSummary(o)).toEqual({ kind: "healthy" });
  });
});

describe("formatBytes", () => {
  it("counts in binary units, one decimal below ten", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2 GB");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 MB");
  });
});
