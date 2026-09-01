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
