package api_test

import (
	"net/http"
	"testing"

	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Help pushes are written in the RECIPIENT's language (help.go,
// internal/push/text.go); a typed message is the sender's own words.
func TestHelpPushesAreInTheRecipientsLanguage(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)
	if res := a.Do(http.MethodPatch, "/api/me", f.kariCookie, map[string]any{"language": "nb"}); res.Status != http.StatusOK {
		t.Fatalf("PATCH /api/me: %d %s", res.Status, res.Raw)
	}

	res := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID})
	if res.Status != http.StatusCreated {
		t.Fatalf("create: %d %s", res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	got := a.Push.Sent(f.kariUserID)
	if len(got) != 1 || got[0].Title != "Rig admin trenger en hånd" || got[0].Body != "Kan du komme?" {
		t.Errorf("to Kari (nb) = %+v", got)
	}

	// The answer goes back to the English-speaking admin in English.
	if ack := a.Do(http.MethodPost, "/api/help/"+id+"/acknowledge", f.kariCookie, nil); ack.Status != http.StatusOK {
		t.Fatalf("acknowledge: %d %s", ack.Status, ack.Raw)
	}
	back := a.Push.Sent(f.adminUserID)
	if len(back) != 1 || back[0].Title != "Kari is on the way" || back[0].Body != "Answered your request" {
		t.Errorf("to the admin (en) = %+v", back)
	}

	// A typed message is sent as written, whatever the language.
	if res := a.Do(http.MethodDelete, "/api/help/"+id, f.adminCookie, nil); res.Status >= 300 {
		t.Fatalf("delete: %d %s", res.Status, res.Raw)
	}
	a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID, "message": "Bring a bottle"})
	if got := a.Push.Sent(f.kariUserID); len(got) != 2 || got[1].Body != "Bring a bottle" {
		t.Errorf("typed message = %+v", got)
	}
}
