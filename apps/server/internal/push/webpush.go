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
	"log"
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

// ToUser sends payload to every subscription registered for userID, then
// prunes whichever ones the push service reported as gone (404 or 410), and
// returns how many deliveries succeeded. A per-subscription send failure
// (network error, non-2xx that isn't 404/410) is neither fatal to the batch
// nor treated as a delivery: it just doesn't count, mirroring the
// TypeScript original's catch-and-continue.
//
// Sending happens for EVERY subscription before any pruning starts —
// deliberately not delete-as-you-go. An early version deleted a dead
// subscription inline, inside the send loop: if that DELETE itself failed,
// ToUser returned early and every subscription later in the slice never got
// a send attempt at all. The TypeScript original never had this failure
// mode (it sent to every subscription via Promise.all, then pruned in one
// batch afterwards) — collecting the dead endpoints and pruning once the
// loop is done restores that guarantee. A prune failure is logged, not
// returned: it must not retroactively undo or misreport the delivered
// count, and the next ToUser call will simply try to prune the same
// still-dead subscription again.
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
	var dead []gen.PushSubscription
	for _, sub := range subs {
		switch w.sendOne(ctx, sub, body) {
		case outcomeOK:
			delivered++
		case outcomeGone:
			dead = append(dead, sub)
		}
	}

	for _, sub := range dead {
		if err := w.q.DeletePushSubscriptionByEndpoint(ctx, sub.Endpoint); err != nil {
			log.Printf("push: prune dead subscription %q: %v", sub.ID, err)
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
		// Matches push.ts's console.warn("push send failed:", err): a
		// transport failure is worth knowing about operationally, even
		// though it's deliberately not fatal to the rest of the batch.
		log.Printf("push: send to subscription %q failed: %v", sub.ID, err)
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
	log.Printf("push: send to subscription %q got unexpected status %d", sub.ID, resp.StatusCode)
	return outcomeError
}
