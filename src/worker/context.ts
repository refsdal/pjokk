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
  };
};

// After requireFamily: the session is present and scoped to one family.
export type FamEnv = {
  Bindings: Env;
  Variables: AppEnv["Variables"] & {
    sessionData: SessionData;
    familyId: string;
    memberRole: string;
    fam: FamilyScope;
  };
};
