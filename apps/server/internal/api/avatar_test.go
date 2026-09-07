package api_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"

	"github.com/refsdal/pjokk/server/internal/api"
	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func solidPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 80, B: 40, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func solidJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// avatarUpload builds a real multipart PUT /api/me/avatar.
func avatarUpload(t *testing.T, cookie, contentType string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="me.img"`)
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
	req := httptest.NewRequest(http.MethodPut, "/api/me/avatar", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	return req
}

func avatarKeys(t *testing.T, a *testrig.AppRig) []string {
	t.Helper()
	objs, err := a.Deps.Storage.(*storage.Memory).List(context.Background(), "avatars/")
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, len(objs))
	for i, o := range objs {
		keys[i] = o.Key
	}
	return keys
}

func TestAvatarUploadStoresAJPEGAndReplacesThePrevious(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	res := a.DoRequest(avatarUpload(t, cookie, "image/png", solidPNG(t, 64, 64)))
	if res.Status != http.StatusOK {
		t.Fatalf("png upload: %d %s", res.Status, res.Raw)
	}
	first, _ := res.JSON["avatarUrl"].(string)
	if first == "" {
		t.Fatalf("avatarUrl missing after upload: %s", res.Raw)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Fatalf("objects after first upload = %v, want 1", got)
	}

	res = a.DoRequest(avatarUpload(t, cookie, "image/jpeg", solidJPEG(t, 32, 32)))
	if res.Status != http.StatusOK {
		t.Fatalf("jpeg upload: %d %s", res.Status, res.Raw)
	}
	second, _ := res.JSON["avatarUrl"].(string)
	if second == first {
		t.Errorf("avatarUrl did not change on re-upload: %s", second)
	}
	if got := avatarKeys(t, a); len(got) != 1 {
		t.Errorf("objects after second upload = %v, want the old one gone", got)
	}

	// GET /api/me agrees.
	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if me.JSON["avatarUrl"] != second {
		t.Errorf("GET /api/me avatarUrl = %v, want %q", me.JSON["avatarUrl"], second)
	}
}

func TestAvatarUploadRejectsWhatIsNotASmallImage(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	cases := []struct {
		name        string
		contentType string
		data        []byte
		status      int
		code        string
	}{
		{"gif bytes", "image/gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), http.StatusUnsupportedMediaType, "BAD_TYPE"},
		{"text claiming to be jpeg", "image/jpeg", []byte("definitely not a jpeg"), http.StatusUnsupportedMediaType, "BAD_TYPE"},
		{"too many pixels", "image/png", solidPNG(t, 1025, 10), http.StatusRequestEntityTooLarge, "TOO_LARGE"},
		{"too many bytes", "image/png", bytes.Repeat([]byte{0}, 512*1024+1), http.StatusRequestEntityTooLarge, "TOO_LARGE"},
	}
	for _, tc := range cases {
		res := a.DoRequest(avatarUpload(t, cookie, tc.contentType, tc.data))
		if res.Status != tc.status || res.JSON["code"] != tc.code {
			t.Errorf("%s: got %d %v, want %d %s", tc.name, res.Status, res.JSON["code"], tc.status, tc.code)
		}
	}
	if got := avatarKeys(t, a); len(got) != 0 {
		t.Errorf("rejected uploads left objects behind: %v", got)
	}

	req := httptest.NewRequest(http.MethodPut, "/api/me/avatar", bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", cookie)
	if res := a.DoRequest(req); res.Status != http.StatusBadRequest || res.JSON["code"] != "NO_FILE" {
		t.Errorf("no multipart: got %d %v, want 400 NO_FILE", res.Status, res.JSON["code"])
	}
}

func TestAvatarIsVisibleToSelfAndCoMembersOnly(t *testing.T) {
	a := testrig.App(t)
	familyID, ownerCookie := a.NewFamily("Hansen", "owner@example.com")
	var ownerID string
	if err := a.Rig.Pool.QueryRow(context.Background(), `SELECT "id" FROM "users" WHERE "email" = $1`, "owner@example.com").Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	peerID := a.SignUp("Peer", "peer@example.com")
	peerCookie := a.AddMember(familyID, peerID, auth.RoleMember, "peer@example.com")
	a.SignUp("Stranger", "stranger@example.com")
	strangerCookie := a.SignIn("stranger@example.com")

	path := "/api/users/" + ownerID + "/avatar"

	// No photo yet: 404 for everyone, including the owner.
	if res := a.Do(http.MethodGet, path, ownerCookie, nil); res.Status != http.StatusNotFound {
		t.Fatalf("before upload: %d, want 404", res.Status)
	}

	if res := a.DoRequest(avatarUpload(t, ownerCookie, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}

	for _, tc := range []struct {
		who    string
		cookie string
		status int
	}{
		{"owner", ownerCookie, http.StatusOK},
		{"co-member", peerCookie, http.StatusOK},
		{"stranger", strangerCookie, http.StatusNotFound},
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

	// A pjk_ key has no face to fetch.
	key := a.CreateAPIKey(familyID, ownerID)
	req = httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	if res := a.DoRequest(req); res.Status != http.StatusForbidden {
		t.Errorf("API key read: %d, want 403", res.Status)
	}
}

func TestAvatarDeleteRemovesTheObject(t *testing.T) {
	a := testrig.App(t)
	id := a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	if res := a.DoRequest(avatarUpload(t, cookie, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}
	res := a.Do(http.MethodDelete, "/api/me/avatar", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("delete: %d %s", res.Status, res.Raw)
	}
	if v := res.JSON["avatarUrl"]; v != nil {
		t.Errorf("avatarUrl after delete = %v, want null", v)
	}
	if got := avatarKeys(t, a); len(got) != 0 {
		t.Errorf("object survived delete: %v", got)
	}
	if res := a.Do(http.MethodGet, fmt.Sprintf("/api/users/%s/avatar", id), cookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("GET after delete: %d, want 404", res.Status)
	}
	// Deleting twice is fine.
	if res := a.Do(http.MethodDelete, "/api/me/avatar", cookie, nil); res.Status != http.StatusOK {
		t.Errorf("second delete: %d, want 200", res.Status)
	}
}

// failingDelete wraps a storage.Storage and makes every Delete call fail,
// to prove deleteAvatar orders its writes so a storage failure leaves the
// avatar_key column untouched (and therefore retryable) rather than
// reporting success while the object leaks.
type failingDelete struct {
	storage.Storage
}

func (failingDelete) Delete(ctx context.Context, keys ...string) error {
	return errors.New("simulated storage outage")
}

func TestAvatarDeleteLeavesTheKeyInPlaceWhenStorageFails(t *testing.T) {
	a := testrig.App(t)
	a.SignUp("Solo", "solo@example.com")
	cookie := a.SignIn("solo@example.com")

	if res := a.DoRequest(avatarUpload(t, cookie, "image/png", solidPNG(t, 40, 40))); res.Status != http.StatusOK {
		t.Fatalf("upload: %d %s", res.Status, res.Raw)
	}

	real := a.Deps.Storage
	a.Configure(func(d *api.Deps) { d.Storage = failingDelete{Storage: real} })

	res := a.Do(http.MethodDelete, "/api/me/avatar", cookie, nil)
	if res.Status != http.StatusInternalServerError {
		t.Fatalf("delete during storage outage: %d %s, want 500", res.Status, res.Raw)
	}

	me := a.Do(http.MethodGet, "/api/me", cookie, nil)
	if v, _ := me.JSON["avatarUrl"].(string); v == "" {
		t.Errorf("avatarUrl after failed delete = %v, want it still set (key must not be cleared)", me.JSON["avatarUrl"])
	}

	// Swap the real store back in and retry: the key survived, so the retry
	// can still find and delete the object.
	a.Configure(func(d *api.Deps) { d.Storage = real })
	res = a.Do(http.MethodDelete, "/api/me/avatar", cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("retried delete: %d %s, want 200", res.Status, res.Raw)
	}
	if v := res.JSON["avatarUrl"]; v != nil {
		t.Errorf("avatarUrl after retried delete = %v, want null", v)
	}
	if got := avatarKeys(t, a); len(got) != 0 {
		t.Errorf("object survived the retried delete: %v", got)
	}
}
