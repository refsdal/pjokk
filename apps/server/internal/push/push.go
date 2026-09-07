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
// JSON tags match apps/api/src/ports.ts's PushPayload ({title, body, url}):
// the payload is sent to the browser's push service as-is and read back by
// the service worker on the other end, so the wire shape is not free to
// drift from the frontend's expectation.
type PushPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
	// Actions are the notification's buttons (issue #51). Android and
	// desktop Chrome show them; iOS and Firefox ignore the field and the
	// tap opens URL as before. public/push-sw.js reads them back.
	Actions []PushAction `json:"actions,omitempty"`
}

// PushAction is one notification button: the URL the app opens when it is
// tapped, e.g. "/home?log=feed" to land straight in the feed sheet.
type PushAction struct {
	Action string `json:"action"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

// Sender delivers a push notification to every subscription registered for
// userID, pruning subscriptions the push service reports as gone (410) along
// the way. It returns how many deliveries succeeded.
type Sender interface {
	ToUser(ctx context.Context, userID string, p PushPayload) (delivered int, err error)
}
