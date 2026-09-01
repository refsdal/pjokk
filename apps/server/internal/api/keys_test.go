package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// API keys — ports apps/api/test/api-keys.test.ts's "api keys" describe
// block (the "baby sex" block in that same file is babies_test.go's, per
// its own comment). middleware_test.go (Task 6) already exercises
// APIKeyAuth's own edge cases (expiry, revocation, read-only, bogus tokens)
// against a hand-inserted row; these tests instead go end-to-end through
// the real /api/keys routes — mint via HTTP, use the minted key against a
// domain route, revoke via HTTP — proving the whole chain the TS suite
// proved in one file.
// -----------------------------------------------------------------------

// bearerDo issues method/path with an `Authorization: Bearer token` header
// (rather than testrig.AppRig.Do's Cookie header) and JSON-marshals body
// when non-nil. Mirrors apps/api/test/api-keys.test.ts's local keyApi()
// helper.
func bearerDo(a *testrig.AppRig, method, path, token string, body any) *testrig.Result {
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return a.DoRequest(req)
}

func TestCreateApiKeyShowsFullKeyOnceListHidesIt(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "Home Assistant"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	key, _ := created.JSON["key"].(string)
	prefix, _ := created.JSON["prefix"].(string)
	if !strings.HasPrefix(key, "pjk_") {
		t.Errorf("key = %q, want a pjk_ prefix", key)
	}
	if !strings.HasPrefix(key, prefix) {
		t.Errorf("key = %q, want to start with prefix %q", key, prefix)
	}
	if created.JSON["name"] != "Home Assistant" {
		t.Errorf("name = %v, want %q", created.JSON["name"], "Home Assistant")
	}
	if created.JSON["readOnly"] != false {
		t.Errorf("readOnly = %v, want false (default)", created.JSON["readOnly"])
	}

	list := a.DoArray(http.MethodGet, "/api/keys", cookie, nil)
	if list.Status != http.StatusOK {
		t.Fatalf("GET status = %d, body %s", list.Status, list.Raw)
	}
	if len(list.JSON) != 1 {
		t.Fatalf("list = %v, want exactly one key", list.JSON)
	}
	row, ok := list.JSON[0].(map[string]any)
	if !ok {
		t.Fatalf("list[0] = %v, want an object", list.JSON[0])
	}
	if row["name"] != "Home Assistant" {
		t.Errorf("list[0].name = %v, want %q", row["name"], "Home Assistant")
	}
	if _, hasKey := row["key"]; hasKey {
		t.Errorf("list[0] = %v, must NOT include the raw key", row)
	}
}

func TestApiKeyReadsAndWritesLogsAttributedToCreator(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "HA"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	key, _ := created.JSON["key"].(string)

	post := bearerDo(a, http.MethodPost, "/api/feeds", key, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 140,
	})
	if post.Status != http.StatusCreated {
		t.Fatalf("POST /api/feeds status = %d, body %s", post.Status, post.Raw)
	}
	if post.JSON["caretakerName"] != "Rig admin" {
		t.Errorf("caretakerName = %v, want %q (the key's creator)", post.JSON["caretakerName"], "Rig admin")
	}

	list := bearerDo(a, http.MethodGet, "/api/babies", key, nil)
	if list.Status != http.StatusOK {
		t.Fatalf("GET /api/babies status = %d, body %s", list.Status, list.Raw)
	}
}

func TestApiKeyRefusedByAdminAndDeviceBoundEndpoints(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "HA"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	key, _ := created.JSON["key"].(string)

	keyCreate := bearerDo(a, http.MethodPost, "/api/keys", key, map[string]any{"name": "x"})
	if keyCreate.Status != http.StatusForbidden {
		t.Errorf("POST /api/keys with key auth: status = %d, body %s, want 403", keyCreate.Status, keyCreate.Raw)
	}
	if keyCreate.JSON["code"] != "FORBIDDEN" {
		t.Errorf("POST /api/keys with key auth: code = %v, want FORBIDDEN", keyCreate.JSON["code"])
	}

	pushTest := bearerDo(a, http.MethodPost, "/api/push/test", key, nil)
	if pushTest.Status != http.StatusForbidden {
		t.Errorf("POST /api/push/test with key auth: status = %d, body %s, want 403", pushTest.Status, pushTest.Raw)
	}
}

func TestReadOnlyApiKeyCanReadNotWrite(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "Grafana", "readOnly": true})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	key, _ := created.JSON["key"].(string)
	if created.JSON["readOnly"] != true {
		t.Errorf("readOnly = %v, want true", created.JSON["readOnly"])
	}

	read := bearerDo(a, http.MethodGet, "/api/babies", key, nil)
	if read.Status != http.StatusOK {
		t.Fatalf("GET /api/babies status = %d, body %s", read.Status, read.Raw)
	}

	write := bearerDo(a, http.MethodPost, "/api/feeds", key, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if write.Status != http.StatusForbidden {
		t.Fatalf("POST /api/feeds status = %d, body %s, want 403", write.Status, write.Raw)
	}
	if write.JSON["code"] != "READ_ONLY_KEY" {
		t.Errorf("code = %v, want READ_ONLY_KEY", write.JSON["code"])
	}
}

func TestApiKeyExpiryIsEnforced(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{
		"name":          "Ephemeral",
		"expiresInDays": 1,
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)
	key, _ := created.JSON["key"].(string)

	stillLive := bearerDo(a, http.MethodGet, "/api/babies", key, nil)
	if stillLive.Status != http.StatusOK {
		t.Fatalf("GET /api/babies (not yet expired) status = %d, body %s", stillLive.Status, stillLive.Raw)
	}

	// Force-expire it directly, same as apps/api/test/api-keys.test.ts's
	// force-expire via the schema.apiKey table.
	if _, err := a.Rig.Pool.Exec(context.Background(),
		`UPDATE "api_key" SET "expires_at" = $1 WHERE "id" = $2`,
		time.Now().Add(-time.Second), id,
	); err != nil {
		t.Fatalf("force-expire: %v", err)
	}

	expired := bearerDo(a, http.MethodGet, "/api/babies", key, nil)
	if expired.Status != http.StatusUnauthorized {
		t.Fatalf("GET /api/babies (expired) status = %d, body %s, want 401", expired.Status, expired.Raw)
	}
	if expired.JSON["code"] != "KEY_EXPIRED" {
		t.Errorf("code = %v, want KEY_EXPIRED", expired.JSON["code"])
	}
}

func TestRevokedAndBogusApiKeysGet401(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/keys", cookie, map[string]any{"name": "HA"})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)
	key, _ := created.JSON["key"].(string)

	stillLive := bearerDo(a, http.MethodGet, "/api/babies", key, nil)
	if stillLive.Status != http.StatusOK {
		t.Fatalf("GET /api/babies (live) status = %d, body %s", stillLive.Status, stillLive.Raw)
	}

	revoke := a.Do(http.MethodDelete, "/api/keys/"+id, cookie, nil)
	if revoke.Status != http.StatusOK {
		t.Fatalf("DELETE status = %d, body %s", revoke.Status, revoke.Raw)
	}
	if revoke.JSON["ok"] != true {
		t.Errorf("DELETE body = %v, want ok:true", revoke.JSON)
	}

	// Revoking a second time (already revoked) is a 404, matching
	// apps/api/src/db/scoped.ts's revokeApiKey guard.
	reRevoke := a.Do(http.MethodDelete, "/api/keys/"+id, cookie, nil)
	if reRevoke.Status != http.StatusNotFound {
		t.Errorf("re-DELETE status = %d, body %s, want 404", reRevoke.Status, reRevoke.Raw)
	}

	afterRevoke := bearerDo(a, http.MethodGet, "/api/babies", key, nil)
	if afterRevoke.Status != http.StatusUnauthorized {
		t.Fatalf("GET /api/babies (revoked) status = %d, body %s, want 401", afterRevoke.Status, afterRevoke.Raw)
	}
	if afterRevoke.JSON["code"] != "INVALID_KEY" {
		t.Errorf("code = %v, want INVALID_KEY", afterRevoke.JSON["code"])
	}

	bogus := bearerDo(a, http.MethodGet, "/api/babies", "pjk_bogus", nil)
	if bogus.Status != http.StatusUnauthorized {
		t.Errorf("GET /api/babies (bogus key) status = %d, body %s, want 401", bogus.Status, bogus.Raw)
	}
	if bogus.JSON["code"] != "INVALID_KEY" {
		t.Errorf("code = %v, want INVALID_KEY", bogus.JSON["code"])
	}
}

func TestApiKeysMemberForbiddenAdminFamilyScoped(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")

	created := a.Do(http.MethodPost, "/api/keys", adminCookie, map[string]any{"name": "HA"})
	if created.Status != http.StatusCreated {
		t.Fatalf("admin POST status = %d, body %s", created.Status, created.Raw)
	}
	id, _ := created.JSON["id"].(string)

	memberID := a.SignUp("Reader", "reader@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "reader@example.com")

	memberList := a.DoArray(http.MethodGet, "/api/keys", memberCookie, nil)
	if memberList.Status != http.StatusForbidden {
		t.Errorf("member GET /api/keys status = %d, body %s, want 403", memberList.Status, memberList.Raw)
	}
	memberCreate := a.Do(http.MethodPost, "/api/keys", memberCookie, map[string]any{"name": "x"})
	if memberCreate.Status != http.StatusForbidden {
		t.Errorf("member POST /api/keys status = %d, body %s, want 403", memberCreate.Status, memberCreate.Raw)
	}
	if memberCreate.JSON["error"] != "Admin only" || memberCreate.JSON["code"] != "FORBIDDEN" {
		t.Errorf("member POST body = %v, want {error:\"Admin only\",code:\"FORBIDDEN\"}", memberCreate.JSON)
	}
	memberDelete := a.Do(http.MethodDelete, "/api/keys/"+id, memberCookie, nil)
	if memberDelete.Status != http.StatusForbidden {
		t.Errorf("member DELETE /api/keys/{id} status = %d, body %s, want 403", memberDelete.Status, memberDelete.Raw)
	}

	// Cross-family isolation: a second family's admin sees none of the
	// first family's keys and cannot revoke them (404, not 403 — the row
	// is simply not theirs to find).
	_, otherCookie := a.NewFamily("Other family", "other@example.com")
	otherList := a.DoArray(http.MethodGet, "/api/keys", otherCookie, nil)
	if len(otherList.JSON) != 0 {
		t.Errorf("other family's key list = %v, want empty (family-scoped)", otherList.JSON)
	}
	otherDelete := a.Do(http.MethodDelete, "/api/keys/"+id, otherCookie, nil)
	if otherDelete.Status != http.StatusNotFound {
		t.Errorf("other family DELETE status = %d, body %s, want 404", otherDelete.Status, otherDelete.Raw)
	}

	// The original key is still there, unrevoked by the other family's
	// failed attempt.
	list := a.DoArray(http.MethodGet, "/api/keys", adminCookie, nil)
	if len(list.JSON) != 1 {
		t.Errorf("admin's key list = %v, want exactly one (unaffected by the other family)", list.JSON)
	}
}
