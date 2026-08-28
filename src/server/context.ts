import type { Auth } from "./auth";
import type { Env } from "./config";
import type { Db } from "./db";
import type { FamilyScope } from "./db/scoped";
import type { RateLimitStore } from "./rate-limit-store";
import type { Storage } from "./storage";

type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type SessionData = NonNullable<SessionResult>;

/**
 * What app.fetch receives as its second argument.
 *
 * Configuration, plus the Bun server handle — the only way to read the peer
 * address, which the rate limiter needs when no proxy sits in front. The
 * handle is optional because tests drive the app without a listening server.
 *
 * IMPORTANT: this must be ONE long-lived object. servicesFor() memoizes on
 * its identity, so building a fresh `{ ...env, server }` per request would
 * silently rebuild the database pool and the whole better-auth chain every
 * time — the exact per-request cost this port set out to remove.
 */
/** Only what the rate limiter needs from the Bun server. Structural rather
 *  than Bun's own Server type, which is generic over its WebSocket data and
 *  would drag that parameter through every route signature. */
export type PeerAddressSource = {
  requestIP(request: Request): { address: string } | null;
};

export type Bindings = Env & { server?: PeerAddressSource };

export type AppEnv = {
  // Hono's "Bindings" is now plain configuration: the process is handed one
  // object at startup and passes it to app.fetch on every request. The
  // long-lived collaborators arrive as Variables instead (see services.ts).
  Bindings: Bindings;
  Variables: {
    auth: Auth;
    db: Db;
    storage: Storage;
    rateLimit: RateLimitStore;
    sessionData: SessionData | null;
    // True when the request authenticated with a pjk_ API key rather than a
    // browser session; admin + device-bound endpoints refuse these.
    apiKeyAuth?: boolean;
  };
};

// After requireFamily: the session is present and scoped to one family.
export type FamEnv = {
  Bindings: Bindings;
  Variables: AppEnv["Variables"] & {
    sessionData: SessionData;
    familyId: string;
    memberRole: string;
    plan: string;
    fam: FamilyScope;
  };
};
