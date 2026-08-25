import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

// Fixed-window counter in KV. Coarse (KV is eventually consistent) but it
// turns brute-forcing invite codes from cheap into pointless.
// scope "ip" buckets per client; "global" is one shared bucket across all
// clients (defeats distributed guessing at the cost of shared-fate 429s —
// use generous limits).
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSeconds: number;
  scope?: "ip" | "global";
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // No spoofable x-forwarded-for fallback: on Cloudflare cf-connecting-ip
    // is always present; anywhere else everyone shares the "unknown" bucket.
    const ip =
      opts.scope === "global"
        ? "global"
        : (c.req.header("cf-connecting-ip") ?? "unknown");
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
