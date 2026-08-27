import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, TimelineSchema, timelineFilters } from "@shared/schemas";
import type { FamEnv } from "../context";
import {
  createApp,
  iso,
  jsonContent,
  serDiaper,
  serFeed,
  serSleep,
} from "../lib";

const timelineQuery = z.object({
  babyId: z.string(),
  // Opaque keyset cursor from a previous page's nextCursor: "<ms>|<id>".
  // The id tiebreak keeps pagination lossless across equal timestamps.
  before: z
    .string()
    .regex(/^\d{1,15}\|.{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // feeds | diapers | sleep = that kind only; other = the Phase 3 types.
  filter: z.enum(timelineFilters).optional(),
});

const timeline = createRoute({
  method: "get",
  path: "/api/timeline",
  tags: ["timeline"],
  description:
    "The merged feed of everything, newest first. Sleep entries sort by their start time; active sessions have endTime null. filter=other selects the phase-3 activity types.",
  request: { query: timelineQuery },
  responses: {
    200: jsonContent(TimelineSchema, "Timeline page"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
  },
});

export const timelineApp = createApp<FamEnv>().openapi(timeline, async (c) => {
  const q = c.req.valid("query");
  if (!(await c.var.fam.getBaby(q.babyId))) {
    return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
  }
  const limit = q.limit ?? 50;
  let before: { time: Date; id: string } | undefined;
  if (q.before) {
    const sep = q.before.indexOf("|");
    before = {
      time: new Date(Number(q.before.slice(0, sep))),
      id: q.before.slice(sep + 1),
    };
  }
  const opts = {
    babyId: q.babyId,
    // Each source over-fetches by the page size so the merge can always
    // fill a full page regardless of the mix.
    limit,
    before,
  };

  const fam = c.var.fam;
  const core = !q.filter;
  const other = !q.filter || q.filter === "other";
  const empty: never[] = [];

  const [
    feeds,
    diapers,
    sleeps,
    medicines,
    baths,
    notes,
    milestones,
    measurements,
    pumps,
    plays,
  ] = await Promise.all([
    core || q.filter === "feeds" ? fam.listFeeds(opts) : empty,
    core || q.filter === "diapers" ? fam.listDiapers(opts) : empty,
    core || q.filter === "sleep" ? fam.listSleeps(opts) : empty,
    other ? fam.medicine.list(opts) : empty,
    other ? fam.bath.list(opts) : empty,
    other ? fam.note.list(opts) : empty,
    other ? fam.milestone.list(opts) : empty,
    other ? fam.measurement.list(opts) : empty,
    other ? fam.pump.list(opts) : empty,
    other ? fam.listPlays(opts) : empty,
  ]);

  const merged = [
    ...feeds.map((f) => ({
      sortKey: f.time.getTime(),
      entry: { kind: "feed" as const, ...serFeed(f) },
    })),
    ...diapers.map((d) => ({
      sortKey: d.time.getTime(),
      entry: { kind: "diaper" as const, ...serDiaper(d) },
    })),
    ...sleeps.map((s) => ({
      sortKey: s.startTime.getTime(),
      entry: { kind: "sleep" as const, ...serSleep(s) },
    })),
    ...medicines.map((m) => ({
      sortKey: m.time.getTime(),
      entry: { ...m, kind: "medicine" as const, time: iso(m.time) },
    })),
    ...baths.map((b) => ({
      sortKey: b.time.getTime(),
      entry: { ...b, kind: "bath" as const, time: iso(b.time) },
    })),
    ...notes.map((n) => ({
      sortKey: n.time.getTime(),
      entry: { ...n, kind: "note" as const, time: iso(n.time) },
    })),
    ...milestones.map((m) => ({
      sortKey: m.time.getTime(),
      entry: { ...m, kind: "milestone" as const, time: iso(m.time) },
    })),
    ...measurements.map((m) => ({
      sortKey: m.time.getTime(),
      entry: { ...m, kind: "measurement" as const, time: iso(m.time) },
    })),
    ...pumps.map((p) => ({
      sortKey: p.time.getTime(),
      entry: { ...p, kind: "pump" as const, time: iso(p.time) },
    })),
    // Play sorts by start time, like sleep; a running one has endTime null.
    ...plays.map((p) => ({
      sortKey: p.startTime.getTime(),
      entry: { kind: "play" as const, ...serSleep(p) },
    })),
  ].sort(
    // Global total order (time DESC, id DESC) — must match the per-source
    // SQL ordering for the keyset cursor to be correct.
    (a, b) => b.sortKey - a.sortKey || (b.entry.id > a.entry.id ? 1 : -1),
  );

  const page = merged.slice(0, limit);
  // More pages exist if the merge already holds more than one page, OR any
  // source filled its own quota (it could have older rows beyond its cut).
  const sources = [
    feeds,
    diapers,
    sleeps,
    medicines,
    baths,
    notes,
    milestones,
    measurements,
    pumps,
    plays,
  ];
  const hasMore =
    merged.length > page.length || sources.some((s) => s.length === limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? `${last.sortKey}|${last.entry.id}` : null;

  return c.json({ entries: page.map((p) => p.entry), nextCursor }, 200);
});
