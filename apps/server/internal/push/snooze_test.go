package push

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

var (
	testKey  = [32]byte{7}
	sentAt   = time.Date(2026, 3, 16, 12, 0, 0, 0, time.UTC)
	reminder = SnoozeClaims{Source: SnoozeReminder, ID: "r1", UserID: "u1", FamilyID: "f1", SentAt: sentAt}
)

func TestSnoozeTokenRoundTrips(t *testing.T) {
	occ := time.Date(2026, 3, 16, 12, 30, 0, 0, time.UTC)
	for _, c := range []SnoozeClaims{reminder, {Source: SnoozeCalendar, ID: "e1", UserID: "u1", FamilyID: "f1", Occurrence: &occ, SentAt: sentAt}} {
		got, err := VerifySnooze(testKey, SignSnooze(testKey, c), sentAt.Add(time.Minute))
		if err != nil {
			t.Fatalf("VerifySnooze(%+v): %v", c, err)
		}
		if got.Source != c.Source || got.ID != c.ID || got.UserID != c.UserID || got.FamilyID != c.FamilyID || !got.SentAt.Equal(c.SentAt) {
			t.Errorf("claims = %+v, want %+v", got, c)
		}
		if (got.Occurrence == nil) != (c.Occurrence == nil) || c.Occurrence != nil && !got.Occurrence.Equal(*c.Occurrence) {
			t.Errorf("occurrence = %v, want %v", got.Occurrence, c.Occurrence)
		}
	}
}

func TestSnoozeTokenRejectsForgeries(t *testing.T) {
	token := SignSnooze(testKey, reminder)
	payload, sig, _ := strings.Cut(token, ".")
	// Another person's claims under the original signature.
	other := reminder
	other.UserID = "u2"
	otherPayload, _, _ := strings.Cut(SignSnooze(testKey, other), ".")
	bogusSource := reminder
	bogusSource.Source = "feed"

	cases := map[string]string{
		"empty":             "",
		"no signature":      payload,
		"not base64":        "!!!." + sig,
		"swapped payload":   otherPayload + "." + sig,
		"another key":       SignSnooze([32]byte{8}, reminder),
		"truncated sig":     payload + "." + sig[:10],
		"unknown source":    SignSnooze(testKey, bogusSource),
		"missing family id": SignSnooze(testKey, SnoozeClaims{Source: SnoozeReminder, ID: "r1", UserID: "u1", SentAt: sentAt}),
	}
	for name, tok := range cases {
		if _, err := VerifySnooze(testKey, tok, sentAt); err != ErrSnoozeToken {
			t.Errorf("%s: err = %v, want ErrSnoozeToken", name, err)
		}
	}
}

func TestSnoozeTokenExpiresAfterTwelveHours(t *testing.T) {
	token := SignSnooze(testKey, reminder)
	if _, err := VerifySnooze(testKey, token, sentAt.Add(12*time.Hour)); err != nil {
		t.Errorf("at 12 h: %v, want valid", err)
	}
	if _, err := VerifySnooze(testKey, token, sentAt.Add(12*time.Hour+time.Second)); err != ErrSnoozeToken {
		t.Errorf("past 12 h: err = %v, want ErrSnoozeToken", err)
	}
	// Minted in the future beyond a minute's skew: not ours.
	if _, err := VerifySnooze(testKey, token, sentAt.Add(-2*time.Minute)); err != ErrSnoozeToken {
		t.Errorf("from the future: err = %v, want ErrSnoozeToken", err)
	}
}

func TestSnoozeActionIsABackgroundPost(t *testing.T) {
	a := SnoozeAction(testKey, reminder)
	if a.Action != "snooze" || a.Title != "Snooze 15 min" || !a.Post {
		t.Fatalf("action = %+v", a)
	}
	u, err := url.Parse(a.URL)
	if err != nil || u.Path != "/api/push/snooze" {
		t.Fatalf("url = %q (%v), want /api/push/snooze?t=…", a.URL, err)
	}
	if _, err := VerifySnooze(testKey, u.Query().Get("t"), sentAt); err != nil {
		t.Errorf("the button's token does not verify: %v", err)
	}
}
