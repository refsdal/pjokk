package push

// The Snooze button on a reminder notification (DECISIONS 2026-09-11).
//
// The button is a background POST the service worker makes without opening
// the app, so it cannot lean on a session: the phone may have no window, the
// session's active family may be another one, the session may have lapsed.
// It carries a signed token instead — who, about what, sent when — keyed
// from AUTH_SECRET with its own domain separator, like the kiosk PIN's HMAC.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

// SnoozeFor is how long "Snooze 15 min" puts a reminder off, counted from
// when the notification was sent. Reminders go out on the 15-minute tick,
// so the snoozed one arrives exactly one tick after the original, however
// long the tap took.
const SnoozeFor = 15 * time.Minute

// snoozeTTL is how long a Snooze button keeps working: long enough for a
// notification read in the morning, not a standing way to schedule pushes.
const snoozeTTL = 12 * time.Hour

// What a snooze is about.
const (
	SnoozeReminder = "reminder" // a caretaker's own reminder row
	SnoozeCalendar = "calendar" // a calendar event's reminder
)

// SnoozeClaims is what a Snooze button's token says.
type SnoozeClaims struct {
	Source   string `json:"s"`
	ID       string `json:"i"` // the reminder's or the calendar event's id
	UserID   string `json:"u"`
	FamilyID string `json:"f"`
	// Occurrence is a calendar reminder's occurrence start.
	Occurrence *time.Time `json:"o,omitempty"`
	SentAt     time.Time  `json:"t"`
}

// ErrSnoozeToken is a token that is malformed, forged or out of date.
var ErrSnoozeToken = errors.New("push: not a valid snooze token")

// SignSnooze renders claims as "<payload>.<mac>", both base64url.
func SignSnooze(key [32]byte, c SnoozeClaims) string {
	body, _ := json.Marshal(c) // plain struct: cannot fail
	payload := base64.RawURLEncoding.EncodeToString(body)
	return payload + "." + base64.RawURLEncoding.EncodeToString(snoozeMAC(key, payload))
}

// VerifySnooze checks a token's signature and age and returns its claims.
func VerifySnooze(key [32]byte, token string, now time.Time) (SnoozeClaims, error) {
	payload, sig, ok := strings.Cut(token, ".")
	if !ok {
		return SnoozeClaims{}, ErrSnoozeToken
	}
	mac, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(mac, snoozeMAC(key, payload)) {
		return SnoozeClaims{}, ErrSnoozeToken
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return SnoozeClaims{}, ErrSnoozeToken
	}
	var c SnoozeClaims
	if err := json.Unmarshal(body, &c); err != nil {
		return SnoozeClaims{}, ErrSnoozeToken
	}
	if c.Source != SnoozeReminder && c.Source != SnoozeCalendar || c.ID == "" || c.UserID == "" || c.FamilyID == "" {
		return SnoozeClaims{}, ErrSnoozeToken
	}
	// Too old, or from the future (a minute's clock skew allowed).
	if now.Sub(c.SentAt) > snoozeTTL || c.SentAt.After(now.Add(time.Minute)) {
		return SnoozeClaims{}, ErrSnoozeToken
	}
	return c, nil
}

func snoozeMAC(key [32]byte, payload string) []byte {
	m := hmac.New(sha256.New, key[:])
	m.Write([]byte("pjokk-snooze:" + payload))
	return m.Sum(nil)
}

// SnoozeAction is the notification's Snooze button: a background POST to
// /api/push/snooze carrying the signed claims.
func SnoozeAction(key [32]byte, c SnoozeClaims) PushAction {
	return PushAction{
		Action: "snooze",
		Title:  "Snooze 15 min",
		URL:    "/api/push/snooze?t=" + url.QueryEscape(SignSnooze(key, c)),
		Post:   true,
	}
}
