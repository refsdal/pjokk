package ratelimit_test

import (
	"context"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/ratelimit"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// REF §A5 item 7. The header is caller-supplied, so it is only consulted
// when the operator has declared how many proxies sit in front, and the
// address is counted from the RIGHT — anything a client prepends sits
// further left and is ignored.
func TestClientIP(t *testing.T) {
	cases := []struct {
		name       string
		forwarded  string
		socket     string
		hops       int
		want       string
		wantReason string
	}{
		{
			name:       "zero hops ignores the header entirely",
			forwarded:  "1.2.3.4",
			socket:     "10.0.0.1:5555",
			hops:       0,
			want:       "10.0.0.1",
			wantReason: "the default deployment has no proxy, so a forged header must not be read",
		},
		{
			name:      "negative hops ignores the header entirely",
			forwarded: "1.2.3.4",
			socket:    "10.0.0.1:5555",
			hops:      -1,
			want:      "10.0.0.1",
		},
		{
			name:       "one hop picks the rightmost entry",
			forwarded:  "9.9.9.9, 1.2.3.4",
			socket:     "10.0.0.1:5555",
			hops:       1,
			want:       "1.2.3.4",
			wantReason: "9.9.9.9 is client-supplied noise ahead of the single trusted proxy",
		},
		{
			name:      "two hops counts back from the right",
			forwarded: "9.9.9.9, 1.2.3.4, 172.16.0.1",
			socket:    "10.0.0.1:5555",
			hops:      2,
			want:      "1.2.3.4",
		},
		{
			name:       "more hops than the chain floors at the leftmost entry",
			forwarded:  "1.2.3.4, 172.16.0.1",
			socket:     "10.0.0.1:5555",
			hops:       5,
			want:       "1.2.3.4",
			wantReason: "a misconfigured hop count must not index out of the chain",
		},
		{
			name:      "whitespace and empty entries are ignored",
			forwarded: "  ,  1.2.3.4 ,   ",
			socket:    "10.0.0.1:5555",
			hops:      1,
			want:      "1.2.3.4",
		},
		{
			name:      "an empty header falls back to the socket address",
			forwarded: "",
			socket:    "10.0.0.1:5555",
			hops:      1,
			want:      "10.0.0.1",
		},
		{
			name:      "no header and no socket address is unknown",
			forwarded: "",
			socket:    "",
			hops:      1,
			want:      "unknown",
		},
		{
			name:      "no header and no socket address is unknown at zero hops too",
			forwarded: "",
			socket:    "",
			hops:      0,
			want:      "unknown",
		},
		{
			name:       "a bare socket address without a port is used as-is",
			forwarded:  "",
			socket:     "10.0.0.1",
			hops:       0,
			want:       "10.0.0.1",
			wantReason: "net/http always sets a port, but callers may pass a normalised address",
		},
		{
			name:       "an IPv6 socket address loses only its port",
			forwarded:  "",
			socket:     "[2001:db8::1]:5555",
			hops:       0,
			want:       "2001:db8::1",
			wantReason: "one bucket per client, not one bucket per connection",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ratelimit.ClientIP(tc.forwarded, tc.socket, tc.hops)
			if got != tc.want {
				t.Errorf("ClientIP(%q, %q, %d) = %q, want %q (%s)",
					tc.forwarded, tc.socket, tc.hops, got, tc.want, tc.wantReason)
			}
		})
	}
}

func TestHitIncrementsWithinAWindowAndIsPerKey(t *testing.T) {
	rig := testrig.Setup(t)
	store := ratelimit.NewPostgres(rig.Q)
	ctx := context.Background()

	for want := 1; want <= 3; want++ {
		count, err := store.Hit(ctx, "rl:test:aaaa:1", 600)
		if err != nil {
			t.Fatalf("Hit: %v", err)
		}
		if count != want {
			t.Fatalf("Hit #%d returned %d, want %d", want, count, want)
		}
	}

	// A different key — which is how the middleware expresses both "another
	// client" and "the next window" — starts its own count from one.
	count, err := store.Hit(ctx, "rl:test:aaaa:2", 600)
	if err != nil {
		t.Fatalf("Hit on a second key: %v", err)
	}
	if count != 1 {
		t.Errorf("first Hit on a fresh key returned %d, want 1", count)
	}
}

func TestSweepDeletesOnlyExpiredCounters(t *testing.T) {
	rig := testrig.Setup(t)
	store := ratelimit.NewPostgres(rig.Q)
	ctx := context.Background()

	if _, err := store.Hit(ctx, "rl:test:live:1", 600); err != nil {
		t.Fatalf("Hit: %v", err)
	}
	// A counter whose window is long gone. Written directly: the store has no
	// way to mint an already-expired row, which is the point.
	if _, err := rig.Pool.Exec(ctx,
		`INSERT INTO "rate_limit" ("key", "count", "expires_at") VALUES ($1, 7, now() - interval '1 hour')`,
		"rl:test:stale:1",
	); err != nil {
		t.Fatalf("insert stale counter: %v", err)
	}

	removed, err := store.Sweep(ctx, time.Now())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if removed != 1 {
		t.Errorf("Sweep removed %d counters, want 1", removed)
	}

	var remaining []string
	rows, err := rig.Pool.Query(ctx, `SELECT "key" FROM "rate_limit"`)
	if err != nil {
		t.Fatalf("read counters back: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatalf("scan key: %v", err)
		}
		remaining = append(remaining, key)
	}
	if len(remaining) != 1 || remaining[0] != "rl:test:live:1" {
		t.Errorf("counters after sweep = %v, want only the live one", remaining)
	}
}
