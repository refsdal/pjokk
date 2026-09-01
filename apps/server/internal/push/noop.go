package push

import "context"

// Noop is a Sender that delivers nothing, without error. The composition
// root uses it when VAPID keys are not configured — a self-hosted
// deployment need not set up web push at all — and tests use it wherever
// push delivery itself is not what's under test.
type Noop struct{}

var _ Sender = Noop{}

// NewNoop builds a Noop sender.
func NewNoop() Noop { return Noop{} }

// ToUser always reports zero deliveries and a nil error.
func (Noop) ToUser(ctx context.Context, userID string, p PushPayload) (int, error) {
	return 0, nil
}
