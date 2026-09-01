package testrig_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// TestAppRigSignUpSignInGatesOnSession is the first end-to-end proof that
// Tasks 4-6 (auth, HTTP shell, middleware chain) compose: SignUp provisions
// a credential account through auth.Service, and the session-gated docs
// route (api.NewHandler's own requireSession helper, not the middleware
// chain) answers 401 without a cookie and 200 with the one SignIn returns.
func TestAppRigSignUpSignInGatesOnSession(t *testing.T) {
	app := testrig.App(t)

	const email = "kari@example.test"
	userID := app.SignUp("Kari Nordmann", email)
	if userID == "" {
		t.Fatal("SignUp returned an empty id")
	}

	noCookie := app.Do(http.MethodGet, "/api/openapi.json", "", nil)
	if noCookie.Status != http.StatusUnauthorized || noCookie.JSON["code"] != "UNAUTHENTICATED" {
		t.Fatalf("GET /api/openapi.json without a cookie = %d %v, want 401 UNAUTHENTICATED",
			noCookie.Status, noCookie.JSON)
	}

	cookie := app.SignIn(email)
	if cookie == "" {
		t.Fatal("SignIn returned an empty cookie")
	}

	withCookie := app.Do(http.MethodGet, "/api/openapi.json", cookie, nil)
	if withCookie.Status != http.StatusOK {
		t.Fatalf("GET /api/openapi.json with a cookie = %d %s", withCookie.Status, withCookie.Raw)
	}
	if withCookie.JSON["openapi"] == nil {
		t.Errorf("spec body missing openapi field: %v", withCookie.JSON)
	}
}

// TestAppRigNewFamilyAndBaby exercises NewFamily/NewBaby against the real
// GET /api/babies route (internal/api/babies.go, Task 9).
func TestAppRigNewFamilyAndBaby(t *testing.T) {
	app := testrig.App(t)

	familyID, cookie := app.NewFamily("Nordmann family", "admin@example.test")
	if familyID == "" || cookie == "" {
		t.Fatalf("NewFamily returned empty values: familyID=%q cookie=%q", familyID, cookie)
	}

	babyID := app.NewBaby(familyID, "Pjokk")
	if babyID == "" {
		t.Fatal("NewBaby returned an empty id")
	}

	res := app.DoArray(http.MethodGet, "/api/babies", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("GET /api/babies = %d %s, want 200", res.Status, res.Raw)
	}
	if len(res.JSON) != 1 {
		t.Fatalf("GET /api/babies JSON = %v, want 1 baby", res.JSON)
	}
	row, ok := res.JSON[0].(map[string]any)
	if !ok || row["id"] != babyID {
		t.Errorf("GET /api/babies[0] = %v, want id %q", res.JSON[0], babyID)
	}
}

// probe is a MountProtected handler that echoes what RequireFamily resolved
// into the request context, so a self-test can assert the middleware chain
// end-to-end without a real domain route existing yet.
func probe(w http.ResponseWriter, r *http.Request) {
	family := middleware.Family(r)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"userId":   family.UserID,
		"familyId": family.FamilyID,
		"role":     family.MemberRole,
	})
}

func probeArray(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]string{"a", "b"})
}

// TestAppRigMountProtectedProvesTheMiddlewareChain drives one handler
// through the exact Session + RequireFamily chain every real family-scoped
// route in Task 9+ will run behind: no session (401 UNAUTHENTICATED), a
// session with no active family (403 NO_FAMILY), and a session with one
// (200, with the resolved family/role echoed back).
func TestAppRigMountProtectedProvesTheMiddlewareChain(t *testing.T) {
	app := testrig.App(t)
	app.MountProtected("GET /api/_test/probe", probe)

	noCookie := app.Do(http.MethodGet, "/api/_test/probe", "", nil)
	if noCookie.Status != http.StatusUnauthorized || noCookie.JSON["code"] != "UNAUTHENTICATED" {
		t.Fatalf("probe without a cookie = %d %v, want 401 UNAUTHENTICATED", noCookie.Status, noCookie.JSON)
	}

	const noFamilyEmail = "lonevar@example.test"
	app.SignUp("Lone Var", noFamilyEmail)
	noFamilyCookie := app.SignIn(noFamilyEmail)
	noFamily := app.Do(http.MethodGet, "/api/_test/probe", noFamilyCookie, nil)
	if noFamily.Status != http.StatusForbidden || noFamily.JSON["code"] != "NO_FAMILY" {
		t.Fatalf("probe signed in with no active family = %d %v, want 403 NO_FAMILY",
			noFamily.Status, noFamily.JSON)
	}

	familyID, cookie := app.NewFamily("Probe family", "admin2@example.test")
	ok := app.Do(http.MethodGet, "/api/_test/probe", cookie, nil)
	if ok.Status != http.StatusOK {
		t.Fatalf("probe with a family session = %d %v, want 200", ok.Status, ok.JSON)
	}
	if ok.JSON["familyId"] != familyID {
		t.Errorf("probe familyId = %v, want %q", ok.JSON["familyId"], familyID)
	}
	if ok.JSON["role"] != "admin" {
		t.Errorf("probe role = %v, want %q", ok.JSON["role"], "admin")
	}
}

// TestAppRigDoArray exercises DoArray against a probe handler that answers
// a JSON array, the shape most list endpoints (babies, timeline entries, …)
// will use from Task 9 on.
func TestAppRigDoArray(t *testing.T) {
	app := testrig.App(t)
	app.MountProtected("GET /api/_test/probe-array", probeArray)
	_, cookie := app.NewFamily("Array family", "arr@example.test")

	res := app.DoArray(http.MethodGet, "/api/_test/probe-array", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("probe-array = %d %s, want 200", res.Status, res.Raw)
	}
	if len(res.JSON) != 2 {
		t.Fatalf("probe-array JSON = %v, want 2 items", res.JSON)
	}
}

// TestAppRigRecordingPush proves the rig's Push is the same Sender wired
// into api.Deps, so a route test can assert on it after driving a request
// that triggers a notification.
func TestAppRigRecordingPush(t *testing.T) {
	app := testrig.App(t)

	if got := app.Push.Count("user-1"); got != 0 {
		t.Fatalf("Count before any send = %d, want 0", got)
	}

	delivered, err := app.Deps.Push.ToUser(context.Background(), "user-1",
		push.PushPayload{Title: "Feed", Body: "Time to feed"})
	if err != nil {
		t.Fatalf("ToUser: %v", err)
	}
	if delivered != 1 {
		t.Errorf("delivered = %d, want 1", delivered)
	}

	sent := app.Push.Sent("user-1")
	if len(sent) != 1 || sent[0].Title != "Feed" {
		t.Fatalf("Sent(user-1) = %v, want one Feed payload", sent)
	}
	if got := app.Push.Count("user-1"); got != 1 {
		t.Errorf("Count after one send = %d, want 1", got)
	}
	if got := app.Push.Count("user-2"); got != 0 {
		t.Errorf("Count for an unrelated user = %d, want 0", got)
	}
}

// TestAppRigSetNow proves the rig's clock is overridable and reverts to the
// wall clock, ahead of any test that needs it (rate-limit windows, API-key
// expiry, reminder scheduling).
func TestAppRigSetNow(t *testing.T) {
	app := testrig.App(t)

	before := app.Deps.Now()
	if before.IsZero() {
		t.Fatal("Deps.Now() returned the zero time before any SetNow call")
	}

	pinned := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	app.SetNow(pinned)
	if got := app.Deps.Now(); !got.Equal(pinned) {
		t.Fatalf("Deps.Now() after SetNow(%v) = %v", pinned, got)
	}

	app.SetNow(time.Time{})
	if app.Deps.Now().Equal(pinned) {
		t.Fatal("Deps.Now() still returns the pinned time after reverting to the wall clock")
	}
}
