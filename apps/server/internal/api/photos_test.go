package api_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Photos on milestones (issue #48): multipart in, server-re-encoded JPEG
// stored under a server-generated key, served back inline through an authed
// route, at most three per milestone and a per-family byte quota.
// -----------------------------------------------------------------------

// realPNG is an actual decodable image, since the upload path proves the
// bytes are one before storing anything.
func realPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func photoUpload(t *testing.T, a *testrig.AppRig, milestoneID, cookie string, body []byte) *testrig.Result {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", "smile.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/milestones/"+milestoneID+"/photos", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Cookie", cookie)
	return a.DoRequest(req)
}

func newMilestone(t *testing.T, a *testrig.AppRig, cookie, babyID, title string) string {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/milestones", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "title": title,
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create milestone: %d %s", res.Status, res.Raw)
	}
	id, _ := res.JSON["id"].(string)
	return id
}

func TestMilestonePhotoUploadServeListDelete(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	milestoneID := newMilestone(t, a, cookie, babyID, "First smile")

	up := photoUpload(t, a, milestoneID, cookie, realPNG(t, 40, 30))
	if up.Status != http.StatusCreated {
		t.Fatalf("upload = %d %s", up.Status, up.Raw)
	}
	if up.JSON["width"] != float64(40) || up.JSON["height"] != float64(30) {
		t.Errorf("dimensions = %v×%v, want 40×30", up.JSON["width"], up.JSON["height"])
	}
	photoID, _ := up.JSON["id"].(string)
	if up.JSON["url"] != "/api/photos/"+photoID {
		t.Errorf("url = %v, want /api/photos/%s", up.JSON["url"], photoID)
	}
	size, _ := up.JSON["size"].(float64)

	// Served back as the re-encoded JPEG, inline, sized as stored.
	got := a.Do(http.MethodGet, "/api/photos/"+photoID, cookie, nil)
	if got.Status != http.StatusOK {
		t.Fatalf("GET photo = %d %s", got.Status, got.Raw)
	}
	if ct := got.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", ct)
	}
	if got.Header.Get("Content-Disposition") != "" {
		t.Errorf("Content-Disposition = %q, want none (our own bytes, served inline)", got.Header.Get("Content-Disposition"))
	}
	if got.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("nosniff missing")
	}
	if len(got.Raw) != int(size) || !bytes.HasPrefix(got.Raw, []byte{0xff, 0xd8}) {
		t.Errorf("body = %d bytes starting %x, want %d bytes of JPEG", len(got.Raw), got.Raw[:2], int(size))
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(got.Raw))
	if err != nil || format != "jpeg" || cfg.Width != 40 || cfg.Height != 30 {
		t.Errorf("stored image = %s %dx%d (%v), want jpeg 40x30", format, cfg.Width, cfg.Height, err)
	}

	// The milestone carries its photos on the list and on the timeline.
	list := a.DoArray(http.MethodGet, "/api/milestones?babyId="+babyID, cookie, nil)
	row, _ := list.JSON[0].(map[string]any)
	photos, _ := row["photos"].([]any)
	if len(photos) != 1 {
		t.Fatalf("milestone.photos = %v, want one", row["photos"])
	}
	if p, _ := photos[0].(map[string]any); p["id"] != photoID || p["url"] != "/api/photos/"+photoID {
		t.Errorf("milestone.photos[0] = %v", photos[0])
	}
	tl := a.Do(http.MethodGet, "/api/timeline?babyId="+babyID, cookie, nil)
	entries, _ := tl.JSON["entries"].([]any)
	if e, _ := entries[0].(map[string]any); e["kind"] != "milestone" || len(e["photos"].([]any)) != 1 {
		t.Errorf("timeline entry = %v, want a milestone with one photo", entries[0])
	}

	// Usage reflects the stored size; the default quota is what Deps says.
	usage := a.Do(http.MethodGet, "/api/photos/usage", cookie, nil)
	if usage.Status != http.StatusOK || usage.JSON["bytes"] != size || usage.JSON["quotaBytes"] != float64(a.Deps.PhotoQuotaBytes) {
		t.Errorf("usage = %d %v, want bytes %v and quotaBytes %d", usage.Status, usage.JSON, size, a.Deps.PhotoQuotaBytes)
	}

	// Delete: row first, then the object.
	del := a.Do(http.MethodDelete, "/api/photos/"+photoID, cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("DELETE = %d %s", del.Status, del.Raw)
	}
	mem := a.Deps.Storage.(*storage.Memory)
	if objs, _ := mem.List(t.Context(), "milestone-photos/"); len(objs) != 0 {
		t.Errorf("objects after delete = %v, want none", objs)
	}
	if again := a.Do(http.MethodGet, "/api/photos/"+photoID, cookie, nil); again.Status != http.StatusNotFound {
		t.Errorf("GET after delete = %d, want 404", again.Status)
	}
}

func TestMilestonePhotoLimitsAndQuota(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	milestoneID := newMilestone(t, a, cookie, babyID, "First tooth")

	if res := photoUpload(t, a, milestoneID, cookie, []byte("not an image at all")); res.Status != http.StatusUnsupportedMediaType || res.JSON["code"] != "BAD_TYPE" {
		t.Errorf("garbage upload = %d %s, want 415 BAD_TYPE", res.Status, res.Raw)
	}
	if res := photoUpload(t, a, "nope", cookie, realPNG(t, 4, 4)); res.Status != http.StatusNotFound {
		t.Errorf("unknown milestone = %d, want 404", res.Status)
	}

	for i := 0; i < 3; i++ {
		if res := photoUpload(t, a, milestoneID, cookie, realPNG(t, 8, 8)); res.Status != http.StatusCreated {
			t.Fatalf("upload %d = %d %s", i+1, res.Status, res.Raw)
		}
	}
	if res := photoUpload(t, a, milestoneID, cookie, realPNG(t, 8, 8)); res.Status != http.StatusBadRequest || res.JSON["code"] != "TOO_MANY" {
		t.Errorf("fourth upload = %d %s, want 400 TOO_MANY", res.Status, res.Raw)
	}

	// A quota one byte above what is already stored refuses the next photo
	// with a message the sheet can show, and never writes the object.
	other := newMilestone(t, a, cookie, babyID, "First word")
	used := a.Do(http.MethodGet, "/api/photos/usage", cookie, nil).JSON["bytes"].(float64)
	a.Deps.PhotoQuotaBytes = int64(used) + 1
	a.Rebuild()
	mem := a.Deps.Storage.(*storage.Memory)
	before, _ := mem.List(t.Context(), "milestone-photos/")
	if res := photoUpload(t, a, other, cookie, realPNG(t, 8, 8)); res.Status != http.StatusRequestEntityTooLarge || res.JSON["code"] != "QUOTA" {
		t.Errorf("over-quota upload = %d %s, want 413 QUOTA", res.Status, res.Raw)
	}
	after, _ := mem.List(t.Context(), "milestone-photos/")
	if len(after) != len(before) {
		t.Errorf("objects after a refused upload = %d, want %d", len(after), len(before))
	}
	// Zero disables the quota.
	a.Deps.PhotoQuotaBytes = 0
	a.Rebuild()
	if res := photoUpload(t, a, other, cookie, realPNG(t, 8, 8)); res.Status != http.StatusCreated {
		t.Errorf("upload with no quota = %d %s, want 201", res.Status, res.Raw)
	}
}

func TestMilestonePhotosAreFamilyScopedAndGoWithTheMilestone(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	_, otherCookie := a.NewFamily("Berg", "other@example.com")
	milestoneID := newMilestone(t, a, cookie, babyID, "First steps")

	up := photoUpload(t, a, milestoneID, cookie, realPNG(t, 6, 6))
	photoID, _ := up.JSON["id"].(string)

	if res := a.Do(http.MethodGet, "/api/photos/"+photoID, otherCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("cross-family GET = %d, want 404", res.Status)
	}
	if res := a.Do(http.MethodDelete, "/api/photos/"+photoID, otherCookie, nil); res.Status != http.StatusNotFound {
		t.Errorf("cross-family DELETE = %d, want 404", res.Status)
	}
	if res := photoUpload(t, a, milestoneID, otherCookie, realPNG(t, 6, 6)); res.Status != http.StatusNotFound {
		t.Errorf("cross-family upload = %d, want 404", res.Status)
	}

	// Deleting the milestone takes its photos' objects with it.
	if res := a.Do(http.MethodDelete, "/api/milestones/"+milestoneID, cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("delete milestone = %d %s", res.Status, res.Raw)
	}
	mem := a.Deps.Storage.(*storage.Memory)
	if objs, _ := mem.List(t.Context(), "milestone-photos/"); len(objs) != 0 {
		t.Errorf("objects after milestone delete = %v, want none", objs)
	}
}
