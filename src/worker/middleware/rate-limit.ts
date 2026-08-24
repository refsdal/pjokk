import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

// Fixed-window counter in KV. Coarse (KV is eventually consistent) but it
// turns brute-forcing invite codes from cheap into pointless.
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSeconds: number;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `rl:${opts.name}:${ip}:${window}`;
    const current = Number((await c.env.KV.get(key)) ?? "0");
    if (current >= opts.limit) {
      return c.json(
        { error: "Too many attempts, try again later", code: "RATE_LIMITED" },
        429,
      );
    }
    // Racy increment is fine here; this is a brake, not an invariant.
    await c.env.KV.put(key, String(current + 1), {
      expirationTtl: Math.max(60, opts.windowSeconds * 2),
    });
    await next();
  });
}
