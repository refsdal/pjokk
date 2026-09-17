package api_test

import (
	"bytes"
	"context"
	"image"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Baby photos (internal/api/baby_avatar.go): the user avatar routes
// (avatar_test.go) transposed onto a baby, which is the family's rather
// than a person's — so the family fence, not co-membership, decides who
// sees it, and a kiosk device sees its own family's babies.

// babyAvatarUpload builds a real multipart PUT /api/babies/{id}/avatar.
func babyAvatarUpload(t *testing.T, cookie, babyID, contentType string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="baby.img"`)
	h.Set("Content-Type", contentType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/babies/"+babyID+"/avatar", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	return req
}

func babyAvatarKeys(t *testing.T, a *testrig.AppRig) []string {
	t.Helper()
	objs, err := a.Deps.Storage.(*storage.Memory).List(context.Background(), "baby-avatars/")
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, len(objs))
	for i, o := range objs {
		keys[i] = o.Key
	}
	return keys
}

func TestBabyAvatarUploadStoresAJPEGAndReplacesThePrevious(t *testing.T) {
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	memberID := a.SignUp("Bo Hansen", "bo@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "bo@example.com")

	// Any member may set the photo — the same rule as editing the baby's
	// details (UpdateBaby is tierFamily).
	res := a.DoRequest(babyAvatarUpload(t, memberCookie, babyID, "image/png", solidPNG(t, 64, 64)))
	if res.Status != http.StatusOK {
		t.Fatalf("png upload: %d %s", res.Status, res.Raw)
	}
	first, _ := res.JSON["avatarUrl"].(string)
	if !strings.HasPrefix(first, "/api/babies/"+babyID+"/avatar?v=") {
		t.Fatalf("avatarUrl after upload = %q, want /api/babies/{id}/avatar?v=…", first)
	}
	if res.JSON["id"] != babyID || res.JSON["name"] != "Nora" {
		t.Errorf("upload did not answer with the Baby: %s", res.Raw)
	}
	keys := babyAvatarKeys(t, a)
	if len(keys) != 1 || !strings.HasPrefix(keys[0], "baby-avatars/"+familyID+"/") {
		t.Fatalf("objects after first upload = %v, want one under baby-avatars/<family>/", keys)
	}

	res = a.DoRequest(babyAvatarUpload(t, adminCookie, babyID, "image/jpeg", solidJPEG(t, 32, 32)))
	if res.Status != http.StatusOK {
		t.Fatalf("jpeg upload: %d %s", res.Status, res.Raw)
	}
	second, _ := res.JSON["avatarUrl"].(string)
	if second == first {
		t.Errorf("avatarUrl did not change on re-upload: %s", second)
	}
	if got := babyAvatarKeys(t, a); len(got) != 1 {
		t.Errorf("objects after second upload = %v, want the old one gone", got)
	}

	// The list agrees.
	list := a.DoArray(http.MethodGet, "/api/babies", memberCookie, nil)
	if len(list.JSON) != 1 {
		t.Fatalf("GET /api/babies = %s", list.Raw)
	}
	if row, _ := list.JSON[0].(map[string]any); row["avatarUrl"] != second {
		t.Errorf("GET /api/babies avatarUrl = %v, want %q", row["avatarUrl"], second)
	}
}

func TestBabyAvatarUploadRejectsWhatIsNotASmallImage(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	cases := []struct {
		name        string
		contentType string
		data        []byte
		status      int
		code        string
	}{
		{"text claiming to be jpeg", "image/jpeg", []byte("definitely not a jpeg"), http.StatusUnsupportedMediaType, "BAD_TYPE"},
		{"too many pixels", "image/png", solidPNG(t, 1025, 10), http.StatusRequestEntityTooLarge, "TOO_LARGE"},
		{"too many bytes", "image/png", bytes.Repeat([]byte{0}, 512*1024+1), http.StatusRequestEntityTooLarge, "TOO_LARGE"},
	}
	for _, tc := range cases {
		res := a.DoRequest(babyAvatarUpload(t, cookie, babyID, tc.contentType, tc.data))
		if res.Status != tc.status || res.JSON["code"] != tc.code {
			t.Errorf("%s: got %d %v, want %d %s", tc.name, res.Status, res.JSON["code"], tc.status, tc.code)
		}
	}
	if got := babyAvatarKeys(t, a); len(got) != 0 {
		t.Errorf("rejected uploads left objects behind: %v", got)
	}

	// Another family's baby is "Not found" — the family fence — and leaves
	// no object either.
	otherFamily, _ := a.NewFamily("Nordmann", "ola@example.com")
	otherBaby := a.NewBaby(otherFamily, "Kari")
	res := a.DoRequest(babyAvatarUpload(t, cookie, otherBaby, "image/png", solidPNG(t, 40, 40)))
	if res.Status != http.StatusNotFound || res.JSON["code"] != "NOT_FOUND" {
		t.Errorf("another family's baby: got %d %v, want 404 NOT_FOUND", res.Status, res.JSON["code"])
	}
	if got := babyAvatarKeys(t, a); len(got) != 0 {
		t.Errorf("a refused upload stored an object: %v", got)
	}
}

func TestBabyAvatarIsVisibleToTheFamilyAndItsDevices(t *testing.T) {
	a := testrig.App(t)
	familyID, ownerCookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	var ownerID string
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT "id" FROM "users" WHERE "email" = $1`, "anne@example.com").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	peerID := a.SignUp("Peer", "peer@example.com")
	peerCookie := a.AddMember(familyID, peerID, auth.RoleMember, "peer@example.com")
	_, strangerCookie := a.NewFamily("Nordmann", "ola@example.com")
	device := a.CreateDevice(familyID, ownerID)

	path := "/api/babies/" + babyID + "/avatar"

	// No photo yet: 404 for everyone.
	if res := a.Do(http.MethodGet, path, ownerCookie, nil); res.Status != http.StatusNotFound {
		t.Fatalf("before upload: %d, want 404", res.Status)
	}

	if res := a.DoRequest(babyAvatarUpload(t, ownerCookie, babyID, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}

	for _, tc := range []struct {
		who    string
		cookie string
		status int
	}{
		{"owner", ownerCookie, http.StatusOK},
		{"co-member", peerCookie, http.StatusOK},
		{"kiosk device", device, http.StatusOK},
		{"another family", strangerCookie, http.StatusNotFound},
		{"anonymous", "", http.StatusUnauthorized},
	} {
		res := a.Do(http.MethodGet, path+"?v=anything", tc.cookie, nil)
		if res.Status != tc.status {
			t.Errorf("%s: status = %d, want %d (body %s)", tc.who, res.Status, tc.status, res.Raw)
			continue
		}
		if tc.status == http.StatusOK {
			if ct := res.Header.Get("Content-Type"); ct != "image/jpeg" {
				t.Errorf("%s: content-type = %q, want image/jpeg", tc.who, ct)
			}
			if res.Header.Get("ETag") == "" || res.Header.Get("Cache-Control") != "private, max-age=86400" {
				t.Errorf("%s: caching headers = %q / %q", tc.who, res.Header.Get("ETag"), res.Header.Get("Cache-Control"))
			}
			if _, format, err := image.DecodeConfig(bytes.NewReader(res.Raw)); err != nil || format != "jpeg" {
				t.Errorf("%s: body is not a decodable jpeg: %v %q", tc.who, err, format)
			}
		}
	}

	// Conditional GET with the served ETag → 304.
	res := a.Do(http.MethodGet, path, peerCookie, nil)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Cookie", peerCookie)
	req.Header.Set("If-None-Match", res.Header.Get("ETag"))
	if res2 := a.DoRequest(req); res2.Status != http.StatusNotModified {
		t.Errorf("If-None-Match: %d, want 304", res2.Status)
	}

	// A pjk_ key has no face to fetch, and none to set.
	key := a.CreateAPIKey(familyID, ownerID)
	req = httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	if res := a.DoRequest(req); res.Status != http.StatusForbidden {
		t.Errorf("API key read: %d, want 403", res.Status)
	}
	req = babyAvatarUpload(t, "", babyID, "image/png", solidPNG(t, 40, 40))
	req.Header.Set("Authorization", "Bearer "+key)
	if res := a.DoRequest(req); res.Status != http.StatusForbidden {
		t.Errorf("API key upload: %d, want 403", res.Status)
	}
	// A device may look, not touch.
	req = babyAvatarUpload(t, device, babyID, "image/png", solidPNG(t, 40, 40))
	req.Header.Set("X-Pjokk-Caretaker", ownerID)
	if res := a.DoRequest(req); res.Status == http.StatusOK {
		t.Errorf("device upload: 200, want a refusal")
	}
}

func TestBabyAvatarDeleteRemovesTheObject(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	path := "/api/babies/" + babyID + "/avatar"

	if res := a.DoRequest(babyAvatarUpload(t, cookie, babyID, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	res := a.Do(http.MethodDelete, path, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("delete: %d %s", res.Status, res.Raw)
	}
	if v := res.JSON["avatarUrl"]; v != nil {
		t.Errorf("avatarUrl after delete = %v, want null", v)
	}
	if got := babyAvatarKeys(t, a); len(got) != 0 {
		t.Errorf("object survived delete: %v", got)
	}
	if res := a.Do(http.MethodGet, path, cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("GET after delete: %d, want 404", res.Status)
	}
	// Deleting twice is fine; deleting another family's is not found.
	if res := a.Do(http.MethodDelete, path, cookie, nil); res.Status != http.StatusOK {
		t.Errorf("second delete: %d, want 200", res.Status)
	}
	_, other := a.NewFamily("Nordmann", "ola@example.com")
	if res := a.Do(http.MethodDelete, path, other, nil); res.Status != http.StatusNotFound {
		t.Errorf("another family's delete: %d, want 404", res.Status)
	}
}

// Deleting the baby (issue #95: erasure reaches the bytes) removes the
// photo object with the row.
func TestDeleteBabyRemovesItsAvatarObject(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "anne@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	if res := a.DoRequest(babyAvatarUpload(t, cookie, babyID, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	if res := a.Do(http.MethodDelete, "/api/babies/"+babyID, cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete baby: %d %s", res.Status, res.Raw)
	}
	if got := babyAvatarKeys(t, a); len(got) != 0 {
		t.Errorf("the baby's photo survived the baby: %v", got)
	}
}

// The family cascade delete (admin.go) takes the babies' photo objects
// with everything else the family owned.
func TestAdminDeleteFamilyRemovesBabyAvatarObjects(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Admin family")
	victimID, victimCookie := a.NewFamily("Doomed family", "doomed@example.com")
	babyID := a.NewBaby(victimID, "Ada")
	if res := a.DoRequest(babyAvatarUpload(t, victimCookie, babyID, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	if del := a.Do(http.MethodDelete, "/api/admin/families/"+victimID, cookie, nil); del.Status != http.StatusOK {
		t.Fatalf("DELETE = %d %s", del.Status, del.Raw)
	}
	if got := babyAvatarKeys(t, a); len(got) != 0 {
		t.Errorf("the family's baby photos survived the family: %v", got)
	}
}
