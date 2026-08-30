import type Stripe from "stripe";
import type { Auth } from "./infrastructure/auth";
import type { Db } from "./db";
import type {
  Clock,
  PeerAddress,
  PushSender,
  RateLimitStore,
  Storage,
} from "./ports";

/**
 * Everything apps/api needs from the outside world.
 *
 * The ONE contract between the two packages: apps/server constructs these and
 * hands them to createApi(); apps/api never builds one itself and never reads
 * process.env. Configuration arrives as plain values, not as an Env object,
 * so a route cannot reach for a setting nobody declared here.
 */
export type Deps = {
  db: Db;
  auth: Auth;
  storage: Storage;
  rateLimit: RateLimitStore;
  push: PushSender;
  peerAddress: PeerAddress;
  now: Clock;
  /** Null when billing is not configured — the SDK throws from its
   *  constructor on an empty key, so a self-hosted instance without Stripe
   *  legitimately has none. Built once at startup, not per request. */
  stripe: Stripe | null;

  /** Public origin. Used for OAuth callbacks and absolute links in push
   *  payloads. */
  appUrl: string;
  /** Handed to the client so it can subscribe; the private half never
   *  leaves apps/server's process memory. */
  vapidPublicKey: string;
  /** Empty string when billing is not configured. */
  stripePriceLifetime: string;
  /** How many proxies sit in front. 0 means X-Forwarded-For is not read. */
  trustedProxyHops: number;
};
