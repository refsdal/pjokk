// Package push declares the web-push port (VAPID) used for feed reminders
// and calendar reminders. This file holds ONLY the interface and its payload
// type — the real implementation (Task 6/7) lives alongside it once it
// lands. Declaring the port now lets api.Deps reference push.Sender without
// waiting on that task.
//
// See docs/superpowers/plans/2026-08-31-go-migration-reference.md §A6.
package push

import "context"

// PushPayload is the notification content delivered to a subscribed device.
type PushPayload struct {
	Title, Body, URL string
}

// Sender delivers a push notification to every subscription registered for
// userID, pruning subscriptions the push service reports as gone (410) along
// the way. It returns how many deliveries succeeded.
type Sender interface {
	ToUser(ctx context.Context, userID string, p PushPayload) (delivered int, err error)
}
