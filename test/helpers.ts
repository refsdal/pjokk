import { env, SELF } from "cloudflare:test";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../src/worker/db";

export const db = () => createDb(env.DB);

export const planOf = async (id: string) =>
  (
    await db()
      .select({ plan: schema.organization.plan })
      .from(schema.organization)
      .where(eq(schema.organization.id, id))
  )[0]!.plan;

export const setPlan = (id: string, plan: string) =>
  db()
    .update(schema.organization)
    .set({ plan })
    .where(eq(schema.organization.id, id));

const PASSWORD = "test-password-123";

// scrypt is ~100ms per call and the password never varies — hash once.
let cachedHash: Promise<string> | undefined;
const passwordHash = () => {
  cachedHash ??= hashPassword(PASSWORD);
  return cachedHash;
};
const BASE = "http://localhost";

let counter = 0;
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createUser(name: string) {
  const id = `user_${uid()}`;
  const email = `${id}@test.local`;
  const now = new Date();
  await db().insert(schema.user).values({
    id,
    name,
    email,
    emailVerified: true,
    // Mirror production: better-auth's admin plugin stamps role "user" on
    // every account it creates (a NULL here once masked a purge bug).
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await db()
    .insert(schema.account)
    .values({
      id: `acc_${uid()}`,
      issuer: "local:credential",
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await passwordHash(),
      createdAt: now,
      updatedAt: now,
    });
  return { id, email, name };
}

export async function createFamily(name: string) {
  const id = `fam_${uid()}`;
  await db().insert(schema.organization).values({
    id,
    name,
    slug: id,
    createdAt: new Date(),
  });
  return { id, name };
}

export async function addMember(
  userId: string,
  familyId: string,
  role: "admin" | "member" = "member",
) {
  await db()
    .insert(schema.member)
    .values({
      id: `mem_${uid()}`,
      organizationId: familyId,
      userId,
      role,
      createdAt: new Date(),
    });
}

export async function createBaby(familyId: string, name = "Baby") {
  const rows = await db()
    .insert(schema.baby)
    .values({
      familyId,
      name,
      birthDate: new Date("2025-10-20T00:00:00Z"),
    })
    .returning();
  return rows[0]!;
}

// Signs in through the real better-auth endpoint and returns a Cookie header.
export async function signIn(email: string) {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return cookies.join("; ");
}

export async function api(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
) {
  return SELF.fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

// One family with an admin + a signed-in cookie + a baby: the standard rig.
export async function rig(familyName = "Rig family") {
  const user = await createUser("Rig admin");
  const family = await createFamily(familyName);
  await addMember(user.id, family.id, "admin");
  const cookie = await signIn(user.email);
  const baby = await createBaby(family.id, "Rig baby");
  return { user, family, cookie, baby };
}
