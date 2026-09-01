package push_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// generateSubscriberKeys mints a fresh P-256 key pair and a random auth
// secret in the shape a real PushSubscription.getKey() would produce
// (base64url, unpadded). webpush-go performs real RFC 8291 encryption
// against these keys before it ever inspects the response, so the test
// needs valid EC points — arbitrary strings fail inside the client before a
// single byte reaches the test server.
func generateSubscriberKeys(t *testing.T) (p256dh, auth string) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate subscriber key: %v", err)
	}
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatalf("generate auth secret: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(secret)
}

func generateVAPIDKeys(t *testing.T) (private, public string) {
	t.Helper()
	private, public, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}
	return private, public
}

// insertFamilyAndUser seeds the minimal rows push_subscription's foreign
// keys need. Mirrors internal/db/db_test.go's insertFamily.
func insertFamilyAndUser(t *testing.T, ctx context.Context, rig *testrig.Rig, familyID, userID string) {
	t.Helper()
	if _, err := rig.Pool.Exec(ctx,
		`INSERT INTO "organizations" ("id", "name", "slug") VALUES ($1, $2, $3)`,
		familyID, "Test Family "+familyID, familyID,
	); err != nil {
		t.Fatalf("insert family: %v", err)
	}
	if _, err := rig.Pool.Exec(ctx,
		`INSERT INTO "users" ("id", "email") VALUES ($1, $2)`,
		userID, userID+"@example.test",
	); err != nil {
		t.Fatalf("insert user: %v", err)
	}
}

func createSubscription(t *testing.T, ctx context.Context, rig *testrig.Rig, familyID, userID, endpoint string) gen.PushSubscription {
	t.Helper()
	p256dh, auth := generateSubscriberKeys(t)
	sub, err := rig.Q.CreatePushSubscription(ctx, gen.CreatePushSubscriptionParams{
		FamilyID: familyID,
		UserID:   userID,
		Endpoint: endpoint,
		P256dh:   p256dh,
		Auth:     auth,
	})
	if err != nil {
		t.Fatalf("CreatePushSubscription: %v", err)
	}
	return sub
}

func TestNewRejectsMissingVAPIDKeys(t *testing.T) {
	rig := testrig.Setup(t)

	if _, err := push.New(rig.Q, "", "priv", "https://app.pjokk.test"); err == nil {
		t.Error("New with an empty public key: got nil error, want one")
	}
	if _, err := push.New(rig.Q, "pub", "", "https://app.pjokk.test"); err == nil {
		t.Error("New with an empty private key: got nil error, want one")
	}
	if _, err := push.New(rig.Q, "", "", ""); err == nil {
		t.Error("New with no keys at all: got nil error, want one")
	}
}

func TestNewSubjectFallsBackToPjokkNoWhenAppURLIsntHTTPS(t *testing.T) {
	rig := testrig.Setup(t)
	priv, pub := generateVAPIDKeys(t)

	httpSender, err := push.New(rig.Q, pub, priv, "http://localhost:3000")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got, want := httpSender.Subject(), "https://pjokk.no"; got != want {
		t.Errorf("Subject() with an http appURL = %q, want %q", got, want)
	}

	httpsSender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got, want := httpsSender.Subject(), "https://app.pjokk.test"; got != want {
		t.Errorf("Subject() with an https appURL = %q, want %q", got, want)
	}
}

func TestNoopDeliversNothingWithoutError(t *testing.T) {
	sender := push.NewNoop()
	delivered, err := sender.ToUser(context.Background(), "whoever", push.PushPayload{Title: "t", Body: "b"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 0 {
		t.Errorf("delivered = %d, want 0", delivered)
	}
}

func TestToUserSendsAndCountsSuccesses(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	var received int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	insertFamilyAndUser(t, ctx, rig, "fam-push-ok", "user-push-ok")
	createSubscription(t, ctx, rig, "fam-push-ok", "user-push-ok", server.URL+"/ok")

	priv, pub := generateVAPIDKeys(t)
	sender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	delivered, err := sender.ToUser(ctx, "user-push-ok", push.PushPayload{Title: "Pjokk", Body: "hi", URL: "/home"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 1 {
		t.Errorf("delivered = %d, want 1", delivered)
	}
	if got := atomic.LoadInt32(&received); got != 1 {
		t.Errorf("test server received %d requests, want 1", got)
	}

	subs, err := rig.Q.ListPushSubscriptionsByUser(ctx, "user-push-ok")
	if err != nil {
		t.Fatalf("ListPushSubscriptionsByUser: %v", err)
	}
	if len(subs) != 1 {
		t.Errorf("subscriptions after a successful send = %d, want 1 (kept)", len(subs))
	}
}

func TestToUserPrunesSubscriptionOn410(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer server.Close()

	insertFamilyAndUser(t, ctx, rig, "fam-push-410", "user-push-410")
	createSubscription(t, ctx, rig, "fam-push-410", "user-push-410", server.URL+"/gone")

	priv, pub := generateVAPIDKeys(t)
	sender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	delivered, err := sender.ToUser(ctx, "user-push-410", push.PushPayload{Title: "t", Body: "b"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 0 {
		t.Errorf("delivered = %d, want 0", delivered)
	}

	subs, err := rig.Q.ListPushSubscriptionsByUser(ctx, "user-push-410")
	if err != nil {
		t.Fatalf("ListPushSubscriptionsByUser: %v", err)
	}
	if len(subs) != 0 {
		t.Errorf("subscriptions after a 410 = %d, want 0 (pruned)", len(subs))
	}
}

func TestToUserPrunesSubscriptionOn404(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	insertFamilyAndUser(t, ctx, rig, "fam-push-404", "user-push-404")
	createSubscription(t, ctx, rig, "fam-push-404", "user-push-404", server.URL+"/missing")

	priv, pub := generateVAPIDKeys(t)
	sender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	delivered, err := sender.ToUser(ctx, "user-push-404", push.PushPayload{Title: "t", Body: "b"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 0 {
		t.Errorf("delivered = %d, want 0", delivered)
	}

	subs, err := rig.Q.ListPushSubscriptionsByUser(ctx, "user-push-404")
	if err != nil {
		t.Fatalf("ListPushSubscriptionsByUser: %v", err)
	}
	if len(subs) != 0 {
		t.Errorf("subscriptions after a 404 = %d, want 0 (pruned)", len(subs))
	}
}

func TestToUserMixedResultsCountsAndPrunesCorrectly(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusCreated) })
	mux.HandleFunc("/gone", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusGone) })
	server := httptest.NewServer(mux)
	defer server.Close()

	insertFamilyAndUser(t, ctx, rig, "fam-push-mixed", "user-push-mixed")
	live := createSubscription(t, ctx, rig, "fam-push-mixed", "user-push-mixed", server.URL+"/ok")
	createSubscription(t, ctx, rig, "fam-push-mixed", "user-push-mixed", server.URL+"/gone")

	priv, pub := generateVAPIDKeys(t)
	sender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	delivered, err := sender.ToUser(ctx, "user-push-mixed", push.PushPayload{Title: "t", Body: "b"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 1 {
		t.Errorf("delivered = %d, want 1", delivered)
	}

	subs, err := rig.Q.ListPushSubscriptionsByUser(ctx, "user-push-mixed")
	if err != nil {
		t.Fatalf("ListPushSubscriptionsByUser: %v", err)
	}
	if len(subs) != 1 || subs[0].Endpoint != live.Endpoint {
		t.Errorf("remaining subscriptions = %+v, want only the live one (%q)", subs, live.Endpoint)
	}
}

func TestToUserWithNoSubscriptionsDeliversNothing(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()
	insertFamilyAndUser(t, ctx, rig, "fam-push-none", "user-push-none")

	priv, pub := generateVAPIDKeys(t)
	sender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	delivered, err := sender.ToUser(ctx, "user-push-none", push.PushPayload{Title: "t", Body: "b"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 0 {
		t.Errorf("delivered = %d, want 0", delivered)
	}
}

// TestToUserAttemptsEverySubscriptionEvenWhenAnEarlierOneIs410 covers the
// review finding that ToUser used to prune a dead subscription inline,
// inside the send loop: a subscription ordered before the LAST one in the
// slice being 410 must not stop the last one from ever being attempted.
// Pruning now happens in a second pass after every send has been attempted,
// so all three subscriptions here must receive a request regardless of the
// order the slice was iterated in.
func TestToUserAttemptsEverySubscriptionEvenWhenAnEarlierOneIs410(t *testing.T) {
	rig := testrig.Setup(t)
	ctx := context.Background()

	var mu sync.Mutex
	var requestOrder []string
	record := func(name string, status int) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			requestOrder = append(requestOrder, name)
			mu.Unlock()
			w.WriteHeader(status)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ok-1", record("ok-1", http.StatusCreated))
	mux.HandleFunc("/gone", record("gone", http.StatusGone))
	mux.HandleFunc("/ok-2", record("ok-2", http.StatusCreated))
	server := httptest.NewServer(mux)
	defer server.Close()

	insertFamilyAndUser(t, ctx, rig, "fam-push-order", "user-push-order")
	createSubscription(t, ctx, rig, "fam-push-order", "user-push-order", server.URL+"/ok-1")
	createSubscription(t, ctx, rig, "fam-push-order", "user-push-order", server.URL+"/gone")
	last := createSubscription(t, ctx, rig, "fam-push-order", "user-push-order", server.URL+"/ok-2")

	priv, pub := generateVAPIDKeys(t)
	sender, err := push.New(rig.Q, pub, priv, "https://app.pjokk.test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	delivered, err := sender.ToUser(ctx, "user-push-order", push.PushPayload{Title: "t", Body: "b"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 2 {
		t.Errorf("delivered = %d, want 2", delivered)
	}

	mu.Lock()
	order := append([]string(nil), requestOrder...)
	mu.Unlock()
	if len(order) != 3 {
		t.Fatalf("request order = %v, want all 3 subscriptions to receive a send attempt", order)
	}
	sawOK2 := false
	for _, name := range order {
		if name == "ok-2" {
			sawOK2 = true
		}
	}
	if !sawOK2 {
		t.Errorf("request order = %v, want the subscription AFTER the 410 (ok-2) to have been attempted", order)
	}

	// The last subscription (the one the old inline-delete code would have
	// abandoned) must still be present: only the 410 one gets pruned.
	subs, err := rig.Q.ListPushSubscriptionsByUser(ctx, "user-push-order")
	if err != nil {
		t.Fatalf("ListPushSubscriptionsByUser: %v", err)
	}
	if len(subs) != 2 {
		t.Fatalf("subscriptions after the send = %d, want 2 (only the 410 pruned)", len(subs))
	}
	foundLast := false
	for _, sub := range subs {
		if sub.Endpoint == last.Endpoint {
			foundLast = true
		}
	}
	if !foundLast {
		t.Errorf("remaining subscriptions = %+v, want the last one (%q) still present", subs, last.Endpoint)
	}
}
