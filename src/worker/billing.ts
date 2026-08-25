import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";

// Stripe subscription statuses that grant Premium. Everything else (canceled,
// incomplete_expired, past_due, unpaid, …) means the family is not paying.
export const PREMIUM_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
]);

// The invariant both directions share: subscription events may only ever
// move a family between "free" and "premium" — lifetime and comp are set
// through other paths and must never be touched by webhook traffic.
export async function applySubscriptionStatus(
  db: Db,
  familyId: string,
  status: string,
): Promise<void> {
  if (PREMIUM_STATUSES.has(status)) {
    await db
      .update(schema.organization)
      .set({ plan: "premium" })
      .where(
        and(
          eq(schema.organization.id, familyId),
          eq(schema.organization.plan, "free"),
        ),
      );
  } else {
    await db
      .update(schema.organization)
      .set({ plan: "free" })
      .where(
        and(
          eq(schema.organization.id, familyId),
          eq(schema.organization.plan, "premium"),
        ),
      );
  }
}

export async function grantLifetime(db: Db, familyId: string): Promise<void> {
  await db
    .update(schema.organization)
    .set({ plan: "lifetime" })
    .where(
      and(
        eq(schema.organization.id, familyId),
        inArray(schema.organization.plan, ["free", "premium"]),
      ),
    );
}
