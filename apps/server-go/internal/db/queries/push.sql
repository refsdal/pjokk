-- Queries backing internal/push (Task 7). See
-- apps/api/src/infrastructure/push.ts for the TypeScript original this
-- ports: load a user's subscriptions, send to each, and delete whichever
-- ones the push service reports as gone (404/410).

-- name: ListPushSubscriptionsByUser :many
SELECT * FROM "push_subscription"
WHERE "user_id" = $1;

-- name: CreatePushSubscription :one
-- Test/fixture helper — the real write path (subscribe/unsubscribe routes)
-- lands with the API handlers, not this task.
INSERT INTO "push_subscription" ("family_id", "user_id", "endpoint", "p256dh", "auth")
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: DeletePushSubscriptionByEndpoint :exec
-- Endpoint is the subscription's identity (unique per push_subscription),
-- so pruning a dead one needs no id round trip first.
DELETE FROM "push_subscription"
WHERE "endpoint" = $1;

-- Queries below back internal/api/push.go (Task 18; REF §A1 push.ts).

-- name: UpsertPushSubscription :exec
-- POST /api/push/subscribe. Re-subscribing the SAME endpoint (a browser can
-- resend its existing subscription, or a device can change hands within a
-- family) rebinds it to whichever caller sent it now rather than failing
-- push_subscription_endpoint_unique — mirrors
-- apps/api/src/routes/push.ts's onConflictDoUpdate.
INSERT INTO "push_subscription" ("family_id", "user_id", "endpoint", "p256dh", "auth")
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT ("endpoint") DO UPDATE SET
  "family_id" = EXCLUDED."family_id",
  "user_id" = EXCLUDED."user_id",
  "p256dh" = EXCLUDED."p256dh",
  "auth" = EXCLUDED."auth";

-- name: DeletePushSubscriptionForUser :execrows
-- POST /api/push/unsubscribe. Scoped to the CALLER's own rows: deleting by
-- endpoint alone would let one caretaker remove another's subscription just
-- by knowing (or guessing) the endpoint URL.
DELETE FROM "push_subscription"
WHERE "endpoint" = $1 AND "user_id" = $2;

-- name: GetPushPref :one
-- GET /api/push/prefs. No row means the caller has never set a preference —
-- internal/api/push.go treats pgx.ErrNoRows as feedReminderHours=0 (off),
-- the default apps/api/src/routes/push.ts's PushPrefsSchema applies.
SELECT * FROM "push_pref"
WHERE "user_id" = $1 AND "family_id" = $2;

-- name: UpsertPushPref :exec
-- PUT /api/push/prefs. A write always resets last_reminded_at to NULL — a
-- new setting starts a fresh observation window rather than firing off the
-- old one's cooldown state (see the OpenAPI operation's summary).
INSERT INTO "push_pref" ("user_id", "family_id", "feed_reminder_hours", "last_reminded_at")
VALUES ($1, $2, $3, NULL)
ON CONFLICT ("user_id", "family_id") DO UPDATE SET
  "feed_reminder_hours" = EXCLUDED."feed_reminder_hours",
  "last_reminded_at" = NULL;
