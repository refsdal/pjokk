import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";
import { sha256Hex } from "../db/scoped";

/**
 * The client's address, as far as it can be trusted.
 *
 * On Workers this was simply cf-connecting-ip, which Cloudflare sets and a
 * caller cannot forge. There is no such header off Cloudflare, and
 * X-Forwarded-For is caller-supplied: trusting it blindly would let anyone
 * mint a fresh rate-limit bucket per request and walk straight through the
 * brake.
 *
 * So the header is only consulted when the operator has declared how many
 * proxies sit in front (TRUSTED_PROXY_HOPS), and the address is counted from
 * the RIGHT — the last entry a trusted proxy actually observed. Anything a
 * client prepends sits further left and is ignored.
 *
 * With 0 hops (the default) the header is not read at all.
 */
export function clientIp(
  forwardedFor: string | null,
  socketAddress: string | null,
  trustedHops: number,
): string {
  if (trustedHops <= 0) return socketAddress ?? "unknown";
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketAddress ?? "unknown";
  // The rightmost entry was appended by the nearest proxy, so hop N back from
  // the end is the address the outermost trusted proxy saw.
  const index = chain.length - trustedHops;
  return chain[Math.max(0, index)] ?? socketAddress ?? "unknown";
}

// Fixed-window counter. scope "ip" buckets per client; "global" is one shared
// bucket across all clients (defeats distributed guessing at the cost of
// shared-fate 429s — use generous limits).
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSeconds: number;
  scope?: "ip" | "global";
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const ip =
      opts.scope === "global"
        ? "global"
        : clientIp(
            c.req.header("x-forwarded-for") ?? null,
            // The peer address, which only the Bun server handle knows.
            // Absent (in tests, or before the server is listening) callers
            // share the "unknown" bucket — safe, just coarse.
            c.var.deps.peerAddress(c.req.raw),
            c.var.deps.trustedProxyHops,
          );
    // Hashed, never the address itself. KV forced this — it was globally
    // replicated with no jurisdiction option — and the counters now live in
    // the same EU database as everything else, but there is still no reason
    // to record addresses, and a hash buckets each client identically.
    const bucket =
      ip === "global" ? "global" : (await sha256Hex(ip)).slice(0, 32);
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `rl:${opts.name}:${bucket}:${window}`;
    // One atomic increment. The KV version read, compared and wrote back,
    // which was racy by nature ("a brake, not an invariant"); with several
    // replicas sharing one database that race would have got materially
    // worse, so the counter is now exact.
    const count = await c.var.rateLimit.hit(key, opts.windowSeconds);
    if (count > opts.limit) {
      return c.json(
        { error: "Too many attempts, try again later", code: "RATE_LIMITED" },
        429,
      );
    }
    await next();
  });
}
