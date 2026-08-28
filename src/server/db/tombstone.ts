import type { Db } from "./index";
import { schema } from "./index";

// Attribution survivor for deleted accounts: has no sign-in methods and is
// banned; log rows point here after their author is removed.
export const TOMBSTONE_ID = "user_tombstone";

export async function ensureTombstone(db: Db) {
  await db
    .insert(schema.user)
    .values({
      id: TOMBSTONE_ID,
      name: "Deleted user",
      email: "deleted@pjokk.invalid",
      emailVerified: false,
      banned: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
}
