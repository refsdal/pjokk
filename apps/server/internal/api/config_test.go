package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

func TestConfigIsPublicAndReflectsDeps(t *testing.T) {
	a := testrig.App(t)                                 // default rig: OpenSignup false, no OAuth providers
	res := a.Do(http.MethodGet, "/api/config", "", nil) // no cookie
	if res.Status != http.StatusOK {
		t.Fatalf("GET /api/config status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["openSignup"] != false {
		t.Errorf("openSignup = %v, want false", res.JSON["openSignup"])
	}
	provs, ok := res.JSON["oauthProviders"].([]any)
	if !ok || len(provs) != 0 {
		t.Errorf("oauthProviders = %v, want []", res.JSON["oauthProviders"])
	}
}
