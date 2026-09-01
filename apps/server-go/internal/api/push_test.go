package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Push subscriptions — ports apps/api/test/push.test.ts's "web push"
// describe block: the SSRF-guarded subscribe endpoint (allowlist +
// upsert-on-endpoint), the caller-scoped unsubscribe, the VAPID config
// route, the feedReminderHours prefs roundtrip, and a test-send via
// testrig's RecordingPush. The TS suite's cron-side runReminders tests are
// NOT ported here — that job is a later task, this one is the HTTP routes
// only. All six operations are tierFamilyNoAPIKey (api.go's
// operationAuthTiers): apps/api/src/app.ts mounts
// domainBase.use("/api/push/*", rejectApiKey) AFTER requireFamily, so a
// pjk_ bearer resolves fine through auth/tenancy and is refused only at
// the push-specific gate — TestPushRoutesForbidAPIKeyAuth below proves
// that end to end for every operation.
// -----------------------------------------------------------------------

// A plausible browser subscription (P-256 public key + auth secret) —
// verbatim from apps/api/test/push.test.ts's SUB_KEYS.
const (
	subP256dh = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM"
	subAuth   = "tBHItJI5svbpez7KI4CCXg"
)

func subscribeBody(endpoint string) map[string]any {
	return map[string]any{"endpoint": endpoint, "p256dh": subP256dh, "auth": subAuth}
}

func TestGetPushConfigReturnsTheVAPIDPublicKey(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/push/config", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	key, _ := res.JSON["publicKey"].(string)
	if len(key) < 60 {
		t.Errorf("publicKey = %q, want the rig's generated VAPID public key (60+ chars)", key)
	}
}

// TestSubscribeRejectsUnrecognizedEndpoints mirrors push.test.ts's "rejects
// endpoints that aren't a known push service (SSRF guard)": a host outright
// off the allowlist, the right host over plain http (downgrade), and a
// suffix-confusion attempt (fcm.googleapis.com.evil.com — a naive
// "contains" or unanchored suffix check would wrongly accept this).
func TestSubscribeRejectsUnrecognizedEndpoints(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	for _, endpoint := range []string{
		"https://evil.example.com/exfil",
		"http://fcm.googleapis.com/downgrade",
		"https://fcm.googleapis.com.evil.com/x",
		"not-a-url",
	} {
		res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, subscribeBody(endpoint))
		if res.Status != http.StatusBadRequest {
			t.Errorf("endpoint %q: status = %d, body %s, want 400", endpoint, res.Status, res.Raw)
			continue
		}
		if res.JSON["code"] != "BAD_ENDPOINT" {
			t.Errorf("endpoint %q: code = %v, want BAD_ENDPOINT", endpoint, res.JSON["code"])
		}
	}
}

// TestSubscribeAcceptsEveryAllowlistedPushServiceHost proves all five hosts
// apps/api/src/routes/push.ts's ALLOWED_PUSH_HOSTS names, plus a subdomain
// of one of them (the regex `/(^|\.)fcm\.googleapis\.com$/` matches both the
// bare host and any subdomain).
func TestSubscribeAcceptsEveryAllowlistedPushServiceHost(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	for _, host := range []string{
		"fcm.googleapis.com",
		"push.apple.com",
		"push.services.mozilla.com",
		"mozaws.net",
		"notify.windows.com",
		"wp.fcm.googleapis.com", // subdomain of an allowed host
	} {
		endpoint := "https://" + host + "/sub/probe"
		res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, subscribeBody(endpoint))
		if res.Status != http.StatusOK {
			t.Errorf("host %q: status = %d, body %s, want 200", host, res.Status, res.Raw)
		}
	}
}

// TestSubscribeUpsertsOnEndpoint mirrors push.test.ts's "stores, re-binds
// and removes subscriptions": subscribing the same endpoint twice is
// idempotent (still one row), and unsubscribing removes it.
func TestSubscribeUpsertsOnEndpoint(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	endpoint := "https://fcm.googleapis.com/sub/one"

	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, subscribeBody(endpoint)); res.Status != http.StatusOK {
		t.Fatalf("first subscribe status = %d, body %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, subscribeBody(endpoint)); res.Status != http.StatusOK {
		t.Fatalf("second subscribe status = %d, body %s", res.Status, res.Raw)
	}

	var count int
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "push_subscription" WHERE "endpoint" = $1`, endpoint,
	).Scan(&count); err != nil {
		t.Fatalf("count subscriptions: %v", err)
	}
	if count != 1 {
		t.Errorf("rows for endpoint = %d, want 1 (upsert, not duplicate insert)", count)
	}

	un := a.Do(http.MethodPost, "/api/push/unsubscribe", cookie, map[string]any{"endpoint": endpoint})
	if un.Status != http.StatusOK {
		t.Fatalf("unsubscribe status = %d, body %s", un.Status, un.Raw)
	}
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "push_subscription" WHERE "endpoint" = $1`, endpoint,
	).Scan(&count); err != nil {
		t.Fatalf("count subscriptions after unsubscribe: %v", err)
	}
	if count != 0 {
		t.Errorf("rows for endpoint after unsubscribe = %d, want 0", count)
	}
}

// TestSubscribeUpsertRebindsUserAndKeys proves a re-subscribe of the SAME
// endpoint by a DIFFERENT family member rebinds ownership and refreshes the
// stored P-256/auth keys, rather than failing the endpoint's unique
// constraint (apps/api/src/routes/push.ts's onConflictDoUpdate).
func TestSubscribeUpsertRebindsUserAndKeys(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	endpoint := "https://fcm.googleapis.com/sub/shared-device"

	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, subscribeBody(endpoint)); res.Status != http.StatusOK {
		t.Fatalf("first subscribe status = %d, body %s", res.Status, res.Raw)
	}

	memberID := a.SignUp("Rig member", "member@example.com")
	memberCookie := a.AddMember(familyID, memberID, "member", "member@example.com")
	rebind := map[string]any{"endpoint": endpoint, "p256dh": "a-different-p256dh-value", "auth": "a-different-auth"}
	if res := a.Do(http.MethodPost, "/api/push/subscribe", memberCookie, rebind); res.Status != http.StatusOK {
		t.Fatalf("re-subscribe status = %d, body %s", res.Status, res.Raw)
	}

	var userID, p256dh, auth string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "user_id", "p256dh", "auth" FROM "push_subscription" WHERE "endpoint" = $1`, endpoint,
	).Scan(&userID, &p256dh, &auth); err != nil {
		t.Fatalf("read subscription: %v", err)
	}
	if userID != memberID {
		t.Errorf("user_id = %q, want the re-subscribing member %q", userID, memberID)
	}
	if p256dh != "a-different-p256dh-value" || auth != "a-different-auth" {
		t.Errorf("keys = (%q, %q), want the re-subscribe's keys", p256dh, auth)
	}
}

// TestUnsubscribeScopedToOwnRows mirrors the TS contract's "unsubscribe
// scoped to own rows": one caretaker cannot remove another's subscription
// by naming its endpoint, even within the same family.
func TestUnsubscribeScopedToOwnRows(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	memberID := a.SignUp("Rig member", "member@example.com")
	memberCookie := a.AddMember(familyID, memberID, "member", "member@example.com")

	adminEndpoint := "https://fcm.googleapis.com/sub/admin"
	memberEndpoint := "https://fcm.googleapis.com/sub/member"
	if res := a.Do(http.MethodPost, "/api/push/subscribe", cookie, subscribeBody(adminEndpoint)); res.Status != http.StatusOK {
		t.Fatalf("admin subscribe status = %d, body %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPost, "/api/push/subscribe", memberCookie, subscribeBody(memberEndpoint)); res.Status != http.StatusOK {
		t.Fatalf("member subscribe status = %d, body %s", res.Status, res.Raw)
	}

	// The admin "unsubscribes" the member's endpoint — still 200 (a
	// set-membership operation, not a lookup), but nothing is deleted.
	res := a.Do(http.MethodPost, "/api/push/unsubscribe", cookie, map[string]any{"endpoint": memberEndpoint})
	if res.Status != http.StatusOK {
		t.Fatalf("cross-user unsubscribe status = %d, body %s", res.Status, res.Raw)
	}
	var count int
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "push_subscription" WHERE "endpoint" = $1`, memberEndpoint,
	).Scan(&count); err != nil {
		t.Fatalf("count member subscription: %v", err)
	}
	if count != 1 {
		t.Errorf("member's subscription survived cross-user unsubscribe? rows = %d, want 1", count)
	}

	// The member removing their OWN endpoint does delete it.
	if res := a.Do(http.MethodPost, "/api/push/unsubscribe", memberCookie, map[string]any{"endpoint": memberEndpoint}); res.Status != http.StatusOK {
		t.Fatalf("own unsubscribe status = %d, body %s", res.Status, res.Raw)
	}
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*)::int FROM "push_subscription" WHERE "endpoint" = $1`, memberEndpoint,
	).Scan(&count); err != nil {
		t.Fatalf("count member subscription after own unsubscribe: %v", err)
	}
	if count != 0 {
		t.Errorf("member's subscription after own unsubscribe = %d, want 0", count)
	}
}

func TestPushPrefsRoundtripDefaultsToZero(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	initial := a.Do(http.MethodGet, "/api/push/prefs", cookie, nil)
	if initial.Status != http.StatusOK {
		t.Fatalf("initial GET status = %d, body %s", initial.Status, initial.Raw)
	}
	if hours, _ := initial.JSON["feedReminderHours"].(float64); hours != 0 {
		t.Errorf("initial feedReminderHours = %v, want 0 (no row yet)", initial.JSON["feedReminderHours"])
	}

	updated := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 4})
	if updated.Status != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", updated.Status, updated.Raw)
	}
	if hours, _ := updated.JSON["feedReminderHours"].(float64); hours != 4 {
		t.Errorf("PUT response feedReminderHours = %v, want 4", updated.JSON["feedReminderHours"])
	}

	after := a.Do(http.MethodGet, "/api/push/prefs", cookie, nil)
	if after.Status != http.StatusOK {
		t.Fatalf("GET after PUT status = %d, body %s", after.Status, after.Raw)
	}
	if hours, _ := after.JSON["feedReminderHours"].(float64); hours != 4 {
		t.Errorf("GET after PUT feedReminderHours = %v, want 4", after.JSON["feedReminderHours"])
	}
}

func TestUpdatePushPrefsRejectsValuesOutsideTheEnum(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 5})
	if res.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, body %s, want 400", res.Status, res.Raw)
	}
	if res.JSON["code"] != "VALIDATION" {
		t.Errorf("code = %v, want VALIDATION", res.JSON["code"])
	}
}

// TestUpdatePushPrefsResetsLastRemindedAt proves a write always clears the
// reminder cooldown: a new setting must start a fresh observation window
// rather than inheriting the old one's "already reminded" state.
func TestUpdatePushPrefsResetsLastRemindedAt(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	if res := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 3}); res.Status != http.StatusOK {
		t.Fatalf("first PUT status = %d, body %s", res.Status, res.Raw)
	}
	if _, err := a.Rig.Pool.Exec(context.Background(),
		`UPDATE "push_pref" SET "last_reminded_at" = now()`,
	); err != nil {
		t.Fatalf("simulate a fired reminder: %v", err)
	}

	if res := a.Do(http.MethodPut, "/api/push/prefs", cookie, map[string]any{"feedReminderHours": 6}); res.Status != http.StatusOK {
		t.Fatalf("second PUT status = %d, body %s", res.Status, res.Raw)
	}

	var lastRemindedAt *string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "last_reminded_at"::text FROM "push_pref"`,
	).Scan(&lastRemindedAt); err != nil {
		t.Fatalf("read last_reminded_at: %v", err)
	}
	if lastRemindedAt != nil {
		t.Errorf("last_reminded_at = %v, want NULL after a new PUT", *lastRemindedAt)
	}
}

func TestTestPushCountsDeliveriesViaRecordingPush(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/push/test", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if sent, _ := res.JSON["sent"].(float64); sent != 1 {
		t.Errorf("sent = %v, want 1 (RecordingPush.ToUser always reports one delivery)", res.JSON["sent"])
	}

	// Confirm the payload actually reached the recording sender, keyed by
	// the caller — not just that the route answered {"sent":1}. Queried by
	// email, not LIMIT 1: db.EnsureTombstone seeds a "deleted@pjokk.invalid"
	// row ahead of any ordering guarantee, so an unqualified LIMIT 1 can
	// return that row instead of the rig's admin.
	var userID string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "users" WHERE "email" = $1`, "parent@example.com",
	).Scan(&userID); err != nil {
		t.Fatalf("read the rig's admin user id: %v", err)
	}
	if got := a.Push.Count(userID); got != 1 {
		t.Fatalf("RecordingPush.Count(admin) = %d, want 1", got)
	}
	payloads := a.Push.Sent(userID)
	if len(payloads) != 1 {
		t.Fatalf("RecordingPush.Sent(admin) = %v, want one payload", payloads)
	}
	if payloads[0].Title != "Pjokk" || payloads[0].URL != "/home" {
		t.Errorf("payload = %+v, want Title=Pjokk URL=/home", payloads[0])
	}
}

// TestPushRoutesForbidAPIKeyAuth proves every /api/push/* operation is
// tierFamilyNoAPIKey: a pjk_ bearer resolves fine through auth/tenancy (the
// key is live, the family membership real) and is refused ONLY at the
// push-specific rejectApiKey gate, matching
// apps/api/src/app.ts's domainBase.use("/api/push/*", rejectApiKey), mounted
// after requireFamily.
func TestPushRoutesForbidAPIKeyAuth(t *testing.T) {
	a := testrig.App(t)
	userID := a.SignUp("Rig admin", "parent@example.com")
	familyID, err := a.Deps.Auth.CreateFamily(context.Background(), userID, "Hansen")
	if err != nil {
		t.Fatalf("CreateFamily: %v", err)
	}
	token := a.CreateAPIKey(familyID, userID)

	cases := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/push/config", nil},
		{http.MethodPost, "/api/push/subscribe", subscribeBody("https://fcm.googleapis.com/sub/key-auth")},
		{http.MethodPost, "/api/push/unsubscribe", map[string]any{"endpoint": "https://fcm.googleapis.com/sub/key-auth"}},
		{http.MethodGet, "/api/push/prefs", nil},
		{http.MethodPut, "/api/push/prefs", map[string]any{"feedReminderHours": 3}},
		{http.MethodPost, "/api/push/test", nil},
	}
	for _, c := range cases {
		var reqBody io.Reader
		if c.body != nil {
			b, err := json.Marshal(c.body)
			if err != nil {
				t.Fatalf("marshal body for %s %s: %v", c.method, c.path, err)
			}
			reqBody = bytes.NewReader(b)
		}
		req := httptest.NewRequest(c.method, c.path, reqBody)
		if c.body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Authorization", "Bearer "+token)

		res := a.DoRequest(req)
		if res.Status != http.StatusForbidden {
			t.Errorf("%s %s: status = %d, body %s, want 403", c.method, c.path, res.Status, res.Raw)
			continue
		}
		if res.JSON["code"] != "FORBIDDEN" {
			t.Errorf("%s %s: code = %v, want FORBIDDEN", c.method, c.path, res.JSON["code"])
		}
	}
}
