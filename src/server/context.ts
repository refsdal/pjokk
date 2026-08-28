import type { Auth } from "./auth";
import type { Db } from "./db";
import type { FamilyScope } from "./db/scoped";

type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;
export type SessionData = NonNullable<SessionResult>;

export type AppEnv = {
  Bindings: Env;
  Variables: {
    auth: Auth;
    db: Db;
    sessionData: SessionData | null;
    // True when the request authenticated with a pjk_ API key rather than a
    // browser session; admin + device-bound endpoints refuse these.
    apiKeyAuth?: boolean;
  };
};

// After requireFamily: the session is present and scoped to one family.
export type FamEnv = {
  Bindings: Env;
  Variables: AppEnv["Variables"] & {
    sessionData: SessionData;
    familyId: string;
    memberRole: string;
    plan: string;
    fam: FamilyScope;
  };
};
