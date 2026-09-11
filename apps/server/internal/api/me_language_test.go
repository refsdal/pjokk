package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// The app's language on the person (me.go, 00018; DECISIONS 2026-09-11).

func TestMeLanguageStartsUnsetAndIsSaved(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if me.JSON["languageMode"] != nil || me.JSON["language"] != "en" {
		t.Fatalf("fresh me: languageMode %v, language %v; want null, en", me.JSON["languageMode"], me.JSON["language"])
	}

	res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"languageMode": "auto", "language": "nb"})
	if res.Status != http.StatusOK || res.JSON["languageMode"] != "auto" || res.JSON["language"] != "nb" {
		t.Fatalf("PATCH language: status %d, body %s", res.Status, res.Raw)
	}
	// Another profile edit leaves the language alone.
	res = a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"units": "imperial"})
	if res.JSON["languageMode"] != "auto" || res.JSON["language"] != "nb" || res.JSON["units"] != "imperial" {
		t.Errorf("after a units edit: %s", res.Raw)
	}
	if me := a.Do(http.MethodGet, "/api/me", cookie, nil); me.JSON["language"] != "nb" {
		t.Errorf("GET after PATCH: %s", me.Raw)
	}
}

func TestMeLanguageRejectsUnknownValues(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	for _, body := range []map[string]any{
		{"language": "de"},
		{"language": "auto"}, // a resolved language is never auto
		{"languageMode": "sv"},
		{"language": nil},
		{"languageMode": nil},
	} {
		if res := a.Do(http.MethodPatch, "/api/me", cookie, body); res.Status != http.StatusBadRequest {
			t.Errorf("PATCH %v: status %d, want 400", body, res.Status)
		}
	}
}

func TestTestPushIsInThePersonsLanguage(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")
	userID, _ := a.Do(http.MethodGet, "/api/me", cookie, nil).JSON["userId"].(string)
	if res := a.Do(http.MethodPatch, "/api/me", cookie, map[string]any{"language": "nb"}); res.Status != http.StatusOK {
		t.Fatalf("PATCH: %d %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodPost, "/api/push/test", cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("test push: %d %s", res.Status, res.Raw)
	}
	if got := a.Push.Sent(userID); len(got) != 1 || got[0].Body != "Varsler fungerer på denne enheten ✅" {
		t.Errorf("pushes = %+v", got)
	}
}
