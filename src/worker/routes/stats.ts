import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema, StatsSchema } from "@shared/schemas";
import type { FamEnv } from "../context";
import { createApp, iso, isoOrNull, jsonContent } from "../lib";

const DAY = 86_400_000;

const statsQuery = z.object({
  babyId: z.string(),
  // Window length in local days, today included.
  days: z.coerce.number().int().min(1).max(90).default(7),
  // The requester's Date.getTimezoneOffset() (minutes, UTC−local). Day
  // buckets follow the caretaker's clock, not the server's.
  tz: z.coerce.number().int().min(-840).max(840).default(0),
});

const stats = createRoute({
  method: "get",
  path: "/api/stats",
  tags: ["stats"],
  description:
    "Per-day sleep/intake/counts plus averages for the window, and the latest weight with its predecessor. Sleep sessions are split across local midnights.",
  request: { query: statsQuery },
  responses: {
    200: jsonContent(StatsSchema, "Stats for the window"),
    404: jsonContent(ErrorSchema, "Unknown baby"),
  },
});

export const statsApp = createApp<FamEnv>().openapi(stats, async (c) => {
  const q = c.req.valid("query");
  if (!(await c.var.fam.getBaby(q.babyId))) {
    return c.json({ error: "Unknown baby", code: "NOT_FOUND" }, 404);
  }

  const tzMs = q.tz * 60_000;
  const dayIndex = (utcMs: number) => Math.floor((utcMs - tzMs) / DAY);
  const now = Date.now();
  const todayIdx = dayIndex(now);
  const startIdx = todayIdx - (q.days - 1);
  const rangeFrom = startIdx * DAY + tzMs;
  const rangeTo = (todayIdx + 1) * DAY + tzMs;

  const [feeds, diapers, sleeps, measurements] = await Promise.all([
    c.var.fam.feedsInRange(q.babyId, new Date(rangeFrom), new Date(rangeTo)),
    c.var.fam.diapersInRange(q.babyId, new Date(rangeFrom), new Date(rangeTo)),
    c.var.fam.sleepsInRange(q.babyId, new Date(rangeFrom), new Date(rangeTo)),
    c.var.fam.measurement.list({ babyId: q.babyId, limit: 100 }),
  ]);

  const buckets = new Map<
    number,
    { sleepMs: number; intakeMl: number; feeds: number; diapers: number }
  >();
  for (let i = startIdx; i <= todayIdx; i++) {
    buckets.set(i, { sleepMs: 0, intakeMl: 0, feeds: 0, diapers: 0 });
  }

  for (const f of feeds) {
    const b = buckets.get(dayIndex(f.time.getTime()));
    if (b) {
      b.feeds += 1;
      b.intakeMl += f.amountMl ?? 0;
    }
  }
  for (const d of diapers) {
    const b = buckets.get(dayIndex(d.time.getTime()));
    if (b) b.diapers += 1;
  }

  // Split each session across the local midnights it crosses. Active
  // sessions count up to now.
  for (const s of sleeps) {
    let cur = Math.max(s.startTime.getTime(), rangeFrom);
    const end = Math.min(s.endTime?.getTime() ?? now, rangeTo, now);
    while (cur < end) {
      const idx = dayIndex(cur);
      const dayEnd = (idx + 1) * DAY + tzMs;
      const chunkEnd = Math.min(end, dayEnd);
      const b = buckets.get(idx);
      if (b) b.sleepMs += chunkEnd - cur;
      cur = chunkEnd;
    }
  }

  const days = [...buckets.entries()].map(([idx, b]) => ({
    date: new Date(idx * DAY).toISOString().slice(0, 10),
    sleepMin: Math.round(b.sleepMs / 60_000),
    intakeMl: b.intakeMl,
    feeds: b.feeds,
    diapers: b.diapers,
  }));

  const sum = (f: (d: (typeof days)[number]) => number) =>
    days.reduce((acc, d) => acc + f(d), 0);

  const weights = measurements.filter((m) => m.type === "weight");
  const [latest, prev] = [weights[0], weights[1]];

  return c.json(
    {
      days,
      avgSleepMin: Math.round(sum((d) => d.sleepMin) / q.days),
      avgIntakeMl: Math.round(sum((d) => d.intakeMl) / q.days),
      avgFeeds: Math.round((sum((d) => d.feeds) / q.days) * 10) / 10,
      avgDiapers: Math.round((sum((d) => d.diapers) / q.days) * 10) / 10,
      weight: latest
        ? {
            value: latest.value,
            time: iso(latest.time),
            prevValue: prev?.value ?? null,
            prevTime: prev ? isoOrNull(prev.time) : null,
          }
        : null,
    },
    200,
  );
});
