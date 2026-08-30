import { and, eq, inArray, isNull, lt, ne, notExists, or } from "drizzle-orm";
import { schema } from "../db";
import type { Deps } from "../deps";
import { TOMBSTONE_ID } from "../db/tombstone";
import { PREMIUM_STATUSES, applySubscriptionStatus } from "../billing";

// Orphan hygiene (sec review H2): accounts created past the invite flow have
// no membership and can't create one — sweep them after a week. Sysadmins
// and anyone with a membership are never touched; FK-protected users (e.g.
// with historical logs) are skipped.
export async function purgeOrphanUsers(deps: Deps, now = deps.now().getTime()) {
  const { db } = deps;
  const cutoff = new Date(now - 7 * 24 * 3600_000);
  const orphans = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(
      and(
        // better-auth's admin plugin stamps role="user" on every account it
        // creates, so match that AND legacy NULLs — never admins.
        or(isNull(schema.user.role), eq(schema.user.role, "user")),
        ne(schema.user.id, TOMBSTONE_ID),
        lt(schema.user.createdAt, cutoff),
        notExists(
          db
            .select({ id: schema.member.id })
            .from(schema.member)
            .where(eq(schema.member.userId, schema.user.id)),
        ),
      ),
    );
  let purged = 0;
  for (const orphan of orphans) {
    try {
      await db.delete(schema.user).where(eq(schema.user.id, orphan.id));
      purged++;
      // Id, never the email: logs are outside our retention control, and an
      // address in them is personal data we cannot later erase.
      console.log(`purge: removed orphan account ${orphan.id}`);
    } catch {
      // FK references (historical data) — leave it alone.
    }
  }
  return purged;
}

// Compensating control for the plugin's fire-and-forget webhook hooks (see
// DECISIONS.md Phase 9): onSubscriptionComplete/Update/Cancel/Deleted swallow
// errors internally so Stripe always sees a 200, which means a failed
// applySubscriptionStatus D1 write is never retried by Stripe. A paying
// family could sit on plan "free" indefinitely. This nightly sweep finds
// that mismatch and repairs it — one-directional only (free -> premium),
// never a downgrade, so it can never race a subscription webhook the wrong
// way: at worst it repeats work applySubscriptionStatus already did.
export async function reconcilePlans(deps: Deps) {
  const { db } = deps;
  const stuck = await db
    .select({
      id: schema.organization.id,
      status: schema.subscription.status,
    })
    .from(schema.organization)
    .innerJoin(
      schema.subscription,
      eq(schema.subscription.referenceId, schema.organization.id),
    )
    .where(
      and(
        eq(schema.organization.plan, "free"),
        inArray(schema.subscription.status, [...PREMIUM_STATUSES]),
      ),
    );
  const seen = new Set<string>();
  let flipped = 0;
  for (const fam of stuck) {
    if (seen.has(fam.id)) continue;
    seen.add(fam.id);
    await applySubscriptionStatus(db, fam.id, fam.status);
    flipped++;
  }
  return flipped;
}
