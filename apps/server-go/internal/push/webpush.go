// WebPush sends via github.com/SherClockHolmes/webpush-go, porting
// apps/api/src/infrastructure/push.ts. That file does its own HTTP round
// trip so it can inspect the response status and prune dead subscriptions;
// webpush-go's SendNotification already returns the raw *http.Response for
// the same reason, so there is no need to hand-roll the request the way the
// TypeScript version did to work around web-push's own all-or-nothing API.
package push

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// defaultSubject is used as the VAPID JWT subject when appURL is not an
// https: URL — VAPID requires "https:" or "mailto:", and local/self-hosted
// dev commonly runs on http:.
const defaultSubject = "https://pjokk.no"

// WebPush is the shipped Sender.
type WebPush struct {
	q          *gen.Queries
	publicKey  string
	privateKey string
	subject    string
}

var _ Sender = (*WebPush)(nil)

// New builds a WebPush sender. Both VAPID keys are required here — an
// unconfigured deployment (no VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) should use
// NewNoop instead. That choice belongs to the composition root, which knows
// whether the operator configured push at all; New itself just refuses to
// construct a sender that could never successfully send.
func New(q *gen.Queries, vapidPublic, vapidPrivate, appURL string) (*WebPush, error) {
	if vapidPublic == "" || vapidPrivate == "" {
		return nil, fmt.Errorf("push: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are both required")
	}
	subject := defaultSubject
	if strings.HasPrefix(appURL, "https:") {
		subject = appURL
	}
	return &WebPush{q: q, publicKey: vapidPublic, privateKey: vapidPrivate, subject: subject}, nil
}

// Subject reports the VAPID JWT subject New resolved (appURL, or
// defaultSubject when appURL isn't https:). Exported for tests; nothing in
// the Sender port needs it.
func (w *WebPush) Subject() string { return w.subject }

// ToUser sends payload to every subscription registered for userID, pruning
// whichever ones the push service reports as gone (404 or 410) along the
// way, and returns how many deliveries succeeded. A per-subscription
// send failure (network error, non-2xx that isn't 404/410) is neither
// fatal to the batch nor treated as a delivery: it just doesn't count,
// mirroring the TypeScript original's catch-and-continue.
func (w *WebPush) ToUser(ctx context.Context, userID string, p PushPayload) (int, error) {
	subs, err := w.q.ListPushSubscriptionsByUser(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("push: list subscriptions for user %q: %w", userID, err)
	}

	body, err := json.Marshal(p)
	if err != nil {
		return 0, fmt.Errorf("push: marshal payload: %w", err)
	}

	delivered := 0
	for _, sub := range subs {
		switch w.sendOne(ctx, sub, body) {
		case outcomeOK:
			delivered++
		case outcomeGone:
			if err := w.q.DeletePushSubscriptionByEndpoint(ctx, sub.Endpoint); err != nil {
				return delivered, fmt.Errorf("push: prune dead subscription %q: %w", sub.ID, err)
			}
		}
	}
	return delivered, nil
}

type sendOutcome int

const (
	outcomeError sendOutcome = iota
	outcomeOK
	outcomeGone
)

func (w *WebPush) sendOne(ctx context.Context, sub gen.PushSubscription, body []byte) sendOutcome {
	resp, err := webpush.SendNotificationWithContext(ctx, body, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.P256dh,
			Auth:   sub.Auth,
		},
	}, &webpush.Options{
		Subscriber:      w.subject,
		VAPIDPublicKey:  w.publicKey,
		VAPIDPrivateKey: w.privateKey,
		TTL:             3600,
	})
	if err != nil {
		return outcomeError
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNotFound, http.StatusGone:
		return outcomeGone
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return outcomeOK
	}
	return outcomeError
}
