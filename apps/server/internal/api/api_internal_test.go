package api

import (
	"net/http/httptest"
	"testing"
)

// TestSkipSpecValidationAvatarPatternIsAnchored pins avatarPattern's shape:
// only the exact GET /api/users/{id}/avatar streaming route is exempt from
// request validation. A bare prefix match on "/api/users/" (the earlier
// shape of this exemption) would silently exempt any future JSON route
// mounted under /api/users/ too — this test would have caught that.
func TestSkipSpecValidationAvatarPatternIsAnchored(t *testing.T) {
	cases := map[string]bool{
		"/api/users/abc/avatar":  true,
		"/api/users/abc/profile": false,
		"/api/users/":            false,
		"/api/users":             false,
	}
	for path, want := range cases {
		req := httptest.NewRequest("GET", path, nil)
		if got := skipSpecValidation(req); got != want {
			t.Errorf("skipSpecValidation(%q) = %v, want %v", path, got, want)
		}
	}
}
