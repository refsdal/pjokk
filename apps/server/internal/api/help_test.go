package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Help requests — docs/superpowers/specs/2026-09-06-help-request-design.md.
// No TypeScript predecessor: this is the first feature designed after the
// Go migration. Push delivery is observed through testrig's RecordingPush.

// helpFamily seeds the standard two-parent household: an admin (the family
// creator, display name "Rig admin") and a member named "Kari".
type helpFamily struct {
	familyID      string
	adminCookie   string
	adminUserID   string
	kariCookie    string
	kariUserID    string
	kariMemberID  string
	adminMemberID string
}

func newHelpFamily(t *testing.T, a *testrig.AppRig) helpFamily {
	t.Helper()
	return newHelpFamilyNamed(t, a, "Hansen", "parent@example.com", "kari@example.com")
}

// Same as newHelpFamily with different emails, for the cross-family tests.
func newHelpFamilyNamed(t *testing.T, a *testrig.AppRig, name, adminEmail, memberEmail string) helpFamily {
	t.Helper()
	familyID, adminCookie := a.NewFamily(name, adminEmail)
	memberUserID := a.SignUp("Kari", memberEmail)
	memberCookie := a.AddMember(familyID, memberUserID, auth.RoleMember, memberEmail)
	members := a.DoArray(http.MethodGet, "/api/family/members", adminCookie, nil)
	f := helpFamily{familyID: familyID, adminCookie: adminCookie, kariCookie: memberCookie, kariUserID: memberUserID}
	for _, raw := range members.JSON {
		m := raw.(map[string]any)
		switch m["email"] {
		case adminEmail:
			f.adminUserID, _ = m["userId"].(string)
			f.adminMemberID, _ = m["memberId"].(string)
		case memberEmail:
			f.kariMemberID, _ = m["memberId"].(string)
		}
	}
	if f.kariMemberID == "" || f.adminMemberID == "" {
		t.Fatalf("could not resolve member ids from %v", members.JSON)
	}
	return f
}

func TestCreateHelpRequestPushesToTheTargetNamingTheSender(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)

	res := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{
		"memberId": f.kariMemberID,
		"message":  "Bring a bottle",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["fromName"] != "Rig admin" || res.JSON["toName"] != "Kari" {
		t.Errorf("names = %v/%v, want Rig admin/Kari", res.JSON["fromName"], res.JSON["toName"])
	}
	if res.JSON["message"] != "Bring a bottle" {
		t.Errorf("message = %v", res.JSON["message"])
	}
	if res.JSON["acknowledgedAt"] != nil || res.JSON["acknowledgedByName"] != nil {
		t.Errorf("fresh request is not open: %v", res.JSON)
	}
	if res.JSON["delivered"] != float64(1) {
		t.Errorf("delivered = %v, want 1 (RecordingPush reports one delivery)", res.JSON["delivered"])
	}

	sent := a.Push.Sent(f.kariUserID)
	if len(sent) != 1 {
		t.Fatalf("pushes to Kari = %v, want exactly one", sent)
	}
	if sent[0].Title != "Rig admin needs a hand" || sent[0].Body != "Bring a bottle" || sent[0].URL != "/home" {
		t.Errorf("payload = %+v", sent[0])
	}
	if a.Push.Count(f.adminUserID) != 0 {
		t.Errorf("the sender was pushed too")
	}
}

func TestCreateHelpRequestDefaultsTheBody(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)

	res := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID})
	if res.Status != http.StatusCreated {
		t.Fatalf("status = %d, body %s", res.Status, res.Raw)
	}
	if res.JSON["message"] != "" {
		t.Errorf("message = %v, want ''", res.JSON["message"])
	}
	if sent := a.Push.Sent(f.kariUserID); len(sent) != 1 || sent[0].Body != "Can you come?" {
		t.Errorf("pushes = %+v, want one with the default body", sent)
	}
}

func TestCreateHelpRequestRejectsSelfAndForeignMembers(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)
	other := newHelpFamilyNamed(t, a, "Olsen", "other-parent@example.com", "other-kari@example.com")

	self := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.adminMemberID})
	if self.Status != http.StatusBadRequest || self.JSON["code"] != "SELF_HELP" {
		t.Errorf("self: status = %d, body %s, want 400 SELF_HELP", self.Status, self.Raw)
	}

	foreign := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": other.kariMemberID})
	if foreign.Status != http.StatusNotFound || foreign.JSON["code"] != "MEMBER_NOT_FOUND" {
		t.Errorf("foreign: status = %d, body %s, want 404 MEMBER_NOT_FOUND", foreign.Status, foreign.Raw)
	}
	if a.Push.Count(other.kariUserID) != 0 {
		t.Errorf("a foreign member was pushed")
	}
}

func TestCreateHelpRequestIsRateLimitedPerUser(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)
	body := map[string]any{"memberId": f.kariMemberID}

	for i := 0; i < 5; i++ {
		if res := a.Do(http.MethodPost, "/api/help", f.adminCookie, body); res.Status != http.StatusCreated {
			t.Fatalf("request %d: status = %d, body %s", i+1, res.Status, res.Raw)
		}
	}
	sixth := a.Do(http.MethodPost, "/api/help", f.adminCookie, body)
	if sixth.Status != http.StatusTooManyRequests || sixth.JSON["code"] != "RATE_LIMITED" {
		t.Errorf("sixth: status = %d, body %s, want 429 RATE_LIMITED", sixth.Status, sixth.Raw)
	}
	// The bucket is per USER, not per household/IP: Kari is unaffected.
	kari := a.Do(http.MethodPost, "/api/help", f.kariCookie, map[string]any{"memberId": f.adminMemberID})
	if kari.Status != http.StatusCreated {
		t.Errorf("other user: status = %d, body %s, want 201", kari.Status, kari.Raw)
	}
}

func TestAcknowledgeHelpRequestPushesTheSenderOnce(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)

	created := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID})
	id, _ := created.JSON["id"].(string)

	ack := a.Do(http.MethodPost, "/api/help/"+id+"/acknowledge", f.kariCookie, nil)
	if ack.Status != http.StatusOK {
		t.Fatalf("ack status = %d, body %s", ack.Status, ack.Raw)
	}
	if ack.JSON["acknowledgedAt"] == nil || ack.JSON["acknowledgedByName"] != "Kari" {
		t.Errorf("ack body = %v, want acknowledgedAt set and acknowledgedByName Kari", ack.JSON)
	}
	if ack.JSON["delivered"] != float64(0) {
		t.Errorf("delivered = %v, want 0 outside the create response", ack.JSON["delivered"])
	}
	sent := a.Push.Sent(f.adminUserID)
	if len(sent) != 1 || sent[0].Title != "Kari is on the way" || sent[0].Body != "Answered your request" || sent[0].URL != "/home" {
		t.Fatalf("pushes to sender = %+v, want one 'Kari is on the way'", sent)
	}

	// Idempotent: a second acknowledge (even by someone else) changes nothing
	// and pushes nothing.
	again := a.Do(http.MethodPost, "/api/help/"+id+"/acknowledge", f.adminCookie, nil)
	if again.Status != http.StatusOK || again.JSON["acknowledgedByName"] != "Kari" {
		t.Errorf("second ack: status = %d, body %s", again.Status, again.Raw)
	}
	if a.Push.Count(f.adminUserID) != 1 {
		t.Errorf("second ack pushed again: %d", a.Push.Count(f.adminUserID))
	}
}

func TestAcknowledgeOwnHelpRequestSendsNoPush(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)

	created := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID})
	id, _ := created.JSON["id"].(string)

	ack := a.Do(http.MethodPost, "/api/help/"+id+"/acknowledge", f.adminCookie, nil)
	if ack.Status != http.StatusOK || ack.JSON["acknowledgedByName"] != "Rig admin" {
		t.Fatalf("ack status = %d, body %s", ack.Status, ack.Raw)
	}
	if a.Push.Count(f.adminUserID) != 0 {
		t.Errorf("sender was pushed about their own acknowledgement")
	}
}

func TestHelpRequestIsInvisibleToOtherFamilies(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)
	other := newHelpFamilyNamed(t, a, "Olsen", "other-parent@example.com", "other-kari@example.com")

	created := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID})
	id, _ := created.JSON["id"].(string)

	if res := a.Do(http.MethodPost, "/api/help/"+id+"/acknowledge", other.adminCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("foreign ack: status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodDelete, "/api/help/"+id, other.adminCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("foreign delete: status = %d, body %s, want 404", res.Status, res.Raw)
	}
	if a.Push.Count(f.adminUserID) != 0 {
		t.Errorf("a foreign acknowledge reached the sender")
	}
}

func TestDeleteHelpRequestSenderOrAdminOnly(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)
	// A third, plain member who is neither sender nor admin.
	olaUserID := a.SignUp("Ola", "ola@example.com")
	olaCookie := a.AddMember(f.familyID, olaUserID, auth.RoleMember, "ola@example.com")

	// Kari (member) sends to the admin; Ola may not dismiss it.
	created := a.Do(http.MethodPost, "/api/help", f.kariCookie, map[string]any{"memberId": f.adminMemberID})
	id, _ := created.JSON["id"].(string)

	if res := a.Do(http.MethodDelete, "/api/help/"+id, olaCookie, nil); res.Status != http.StatusForbidden || res.JSON["code"] != "NOT_SENDER" {
		t.Errorf("bystander delete: status = %d, body %s, want 403 NOT_SENDER", res.Status, res.Raw)
	}
	// The sender may.
	if res := a.Do(http.MethodDelete, "/api/help/"+id, f.kariCookie, nil); res.Status != http.StatusOK {
		t.Errorf("sender delete: status = %d, body %s, want 200", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodDelete, "/api/help/"+id, f.kariCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("deleting twice: status = %d, want 404", res.Status)
	}

	// An admin who is not the sender may too.
	created = a.Do(http.MethodPost, "/api/help", f.kariCookie, map[string]any{"memberId": f.adminMemberID})
	id, _ = created.JSON["id"].(string)
	if res := a.Do(http.MethodDelete, "/api/help/"+id, f.adminCookie, nil); res.Status != http.StatusOK {
		t.Errorf("admin delete: status = %d, body %s, want 200", res.Status, res.Raw)
	}
}

// Mirrors push_test.go's TestPushRoutesForbidAPIKeyAuth: a live pjk_ key
// resolves through auth/tenancy and is refused only at the no-API-key gate.
func TestHelpRoutesForbidAPIKeyAuth(t *testing.T) {
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
		{http.MethodPost, "/api/help", map[string]any{"memberId": "x"}},
		{http.MethodPost, "/api/help/x/acknowledge", nil},
		{http.MethodDelete, "/api/help/x", nil},
	}
	for _, c := range cases {
		var reqBody io.Reader
		if c.body != nil {
			b, err := json.Marshal(c.body)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			reqBody = bytes.NewReader(b)
		}
		req := httptest.NewRequest(c.method, c.path, reqBody)
		if c.body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		res := a.DoRequest(req)
		if res.Status != http.StatusForbidden || res.JSON["code"] != "FORBIDDEN" {
			t.Errorf("%s %s: status = %d, body %s, want 403 FORBIDDEN", c.method, c.path, res.Status, res.Raw)
		}
	}
}

func TestSummaryCarriesTheNewestHelpRequestWithinTwoHours(t *testing.T) {
	a := testrig.App(t)
	f := newHelpFamily(t, a)
	babyID := a.NewBaby(f.familyID, "Nora")

	none := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, f.kariCookie, nil)
	if none.Status != http.StatusOK {
		t.Fatalf("summary status = %d, body %s", none.Status, none.Raw)
	}
	if none.JSON["openHelp"] != nil {
		t.Errorf("openHelp with no requests = %v, want null", none.JSON["openHelp"])
	}

	first := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID, "message": "first"})
	second := a.Do(http.MethodPost, "/api/help", f.adminCookie, map[string]any{"memberId": f.kariMemberID, "message": "second"})
	if first.Status != http.StatusCreated || second.Status != http.StatusCreated {
		t.Fatalf("create statuses = %d/%d", first.Status, second.Status)
	}

	// Everyone in the family sees it, and it is the NEWEST one.
	got := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, f.kariCookie, nil)
	open, _ := got.JSON["openHelp"].(map[string]any)
	if open == nil || open["id"] != second.JSON["id"] {
		t.Fatalf("openHelp = %v, want the second request", got.JSON["openHelp"])
	}
	if open["delivered"] != float64(0) {
		t.Errorf("delivered on summary = %v, want 0", open["delivered"])
	}

	// Acknowledged requests stay visible inside the window (the card goes calm).
	id, _ := second.JSON["id"].(string)
	a.Do(http.MethodPost, "/api/help/"+id+"/acknowledge", f.kariCookie, nil)
	acked := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, f.adminCookie, nil)
	if open, _ := acked.JSON["openHelp"].(map[string]any); open == nil || open["acknowledgedByName"] != "Kari" {
		t.Errorf("openHelp after ack = %v, want acknowledged by Kari", acked.JSON["openHelp"])
	}

	// Two hours and a minute later it is gone — no cron, just the window.
	a.SetNow(time.Now().Add(2*time.Hour + time.Minute))
	stale := a.Do(http.MethodGet, "/api/summary?babyId="+babyID, f.adminCookie, nil)
	if stale.JSON["openHelp"] != nil {
		t.Errorf("openHelp after the window = %v, want null", stale.JSON["openHelp"])
	}
}
