import type { Db } from "./db";
import type { FamilyScope } from "./db/scoped";
import type { Deps } from "./deps";
import type { Auth } from "./infrastructure/auth";
import type { RateLimitStore, Storage } from "./ports";

type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type SessionData = NonNullable<SessionResult>;

export type AppEnv = {
  // Nothing arrives through Hono's env any more: the process hands
  // createApi() one Deps object at startup and it is captured in the
  // closure. Kept as an empty type rather than removed so the generic
  // parameter shape is unchanged.
  Bindings: Record<string, never>;
  Variables: {
    deps: Deps;
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
  Bindings: Record<string, never>;
  Variables: AppEnv["Variables"] & {
    sessionData: SessionData;
    familyId: string;
    memberRole: string;
    plan: string;
    fam: FamilyScope;
  };
};
