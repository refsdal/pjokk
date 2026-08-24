import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, TimelineSchema, timelineFilters } from "@shared/schemas";
import type { FamEnv } from "../context";
import { createApp, jsonContent, serDiaper, serFeed, serSleep } from "../lib";

const timelineQuery = z.object({
  babyId: z.string(),
  // ISO cursor: return entries strictly older than this (from a previous
  // page's nextCursor).
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  filter: z.enum(timelineFilters).optional(),
});

const timeline = createRoute({
  method: "get",
  path: "/api/timeline",
  tags: ["timeline"],
  description:
    "The merged feed of everything (feeds, diapers, sleep), newest first. Sleep entries sort by their start time; active sessions have endTime null.",
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
  const opts = {
    babyId: q.babyId,
    // Each source over-fetches by the page size so the merge can always
    // fill a full page regardless of the mix.
    limit,
    before: q.before ? new Date(q.before) : undefined,
  };

  const [feeds, diapers, sleeps] = await Promise.all([
    !q.filter || q.filter === "feeds"
      ? c.var.fam.listFeeds(opts)
      : Promise.resolve([]),
    !q.filter || q.filter === "diapers"
      ? c.var.fam.listDiapers(opts)
      : Promise.resolve([]),
    !q.filter || q.filter === "sleep"
      ? c.var.fam.listSleeps(opts)
      : Promise.resolve([]),
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
  ].sort((a, b) => b.sortKey - a.sortKey);

  const page = merged.slice(0, limit);
  // More pages exist if the merge already holds more than one page, OR any
  // source filled its own quota (it could have older rows beyond its cut).
  const hasMore =
    merged.length > limit ||
    feeds.length === limit ||
    diapers.length === limit ||
    sleeps.length === limit;
  const nextCursor =
    hasMore && page.length > 0
      ? new Date(page[page.length - 1]!.sortKey).toISOString()
      : null;

  return c.json(
    { entries: page.map((p) => p.entry), nextCursor },
    200,
  );
});
