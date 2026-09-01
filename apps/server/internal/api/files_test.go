package api_test

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Vaccine documents — ports apps/api/test/vaccines.test.ts's "vaccine
// documents (uploads disabled)" describe block.
// -----------------------------------------------------------------------

// multipartUpload builds a real multipart/form-data POST to
// /api/vaccines/{id}/documents, mirroring the TS suite's own upload()
// helper (which deliberately avoids the JSON-only api() helper for exactly
// this reason).
func multipartUpload(t *testing.T, vaccineID, cookie, filename, contentType string, bytesIn []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := part.Write(bytesIn); err != nil {
		t.Fatalf("write file bytes: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/vaccines/"+vaccineID+"/documents", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Cookie", cookie)
	return req
}

func pngBytes() []byte {
	return []byte{0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4}
}

func TestUploadVaccineDocumentAlwaysRefusedFeatureDisabled(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("POST vaccine status = %d, body %s", created.Status, created.Raw)
	}
	vaccineID, _ := created.JSON["id"].(string)

	req := multipartUpload(t, vaccineID, cookie, "card.png", "image/png", pngBytes())
	res := a.DoRequest(req)
	if res.Status != http.StatusForbidden {
		t.Fatalf("status = %d, body %s, want 403", res.Status, res.Raw)
	}
	if res.JSON["code"] != "FEATURE_DISABLED" {
		t.Errorf("code = %v, want %q", res.JSON["code"], "FEATURE_DISABLED")
	}
}

// -----------------------------------------------------------------------
// /api/files/{id} — reading and deleting must keep working for anything
// already stored, whatever DocumentUploadsEnabled says, since disabling
// the feature must not strand data a family has the right to get back and
// delete. Documents are seeded directly (memory storage + a sqlc insert),
// bypassing the disabled upload route entirely.
// -----------------------------------------------------------------------

// adminUserID reads familyID's one member's user id directly via SQL —
// mirrors play_test.go's TestCreatePlayRunningSessionDBEnforcedRace, the
// established way this suite bypasses HTTP for direct-DB test setup.
func adminUserID(t *testing.T, a *testrig.AppRig, familyID string) string {
	t.Helper()
	var userID string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "user_id" FROM "organization_members" WHERE "organization_id" = $1 LIMIT 1`, familyID,
	).Scan(&userID); err != nil {
		t.Fatalf("find the admin's user id: %v", err)
	}
	return userID
}

func seedVaccineDocument(t *testing.T, a *testrig.AppRig, familyID, vaccineID, objectKey, filename, contentType string, body []byte) string {
	t.Helper()
	mem, ok := a.Deps.Storage.(*storage.Memory)
	if !ok {
		t.Fatalf("rig storage is %T, want *storage.Memory", a.Deps.Storage)
	}
	if err := mem.Put(context.Background(), objectKey, bytes.NewReader(body), int64(len(body)), contentType); err != nil {
		t.Fatalf("seed object %q: %v", objectKey, err)
	}
	docID, err := a.Deps.Q.CreateVaccineDocument(context.Background(), dbgen.CreateVaccineDocumentParams{
		FamilyID:     familyID,
		VaccineLogID: vaccineID,
		ObjectKey:    objectKey,
		Filename:     filename,
		ContentType:  contentType,
		Size:         int32(len(body)),
		UploadedBy:   adminUserID(t, a, familyID),
	})
	if err != nil {
		t.Fatalf("seed vaccine_document row: %v", err)
	}
	return docID
}

func TestGetFileServesAndDeleteRemovesASeededDocument(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	vaccineID, _ := created.JSON["id"].(string)

	body := pngBytes()
	objectKey := "vaccine-docs/" + familyID + "/seeded"
	docID := seedVaccineDocument(t, a, familyID, vaccineID, objectKey, `card "one".png`, "image/png", body)

	fetched := a.Do(http.MethodGet, "/api/files/"+docID, cookie, nil)
	if fetched.Status != http.StatusOK {
		t.Fatalf("GET status = %d, body %s", fetched.Status, fetched.Raw)
	}
	if got := fetched.Header.Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want %q", got, "image/png")
	}
	if got := fetched.Header.Get("Content-Length"); got != "8" {
		t.Errorf("Content-Length = %q, want %q", got, "8")
	}
	wantDisposition := `attachment; filename="card one.png"`
	if got := fetched.Header.Get("Content-Disposition"); got != wantDisposition {
		t.Errorf("Content-Disposition = %q, want %q (never inline, quotes stripped)", got, wantDisposition)
	}
	if got := fetched.Header.Get("Cache-Control"); got != "private, max-age=3600" {
		t.Errorf("Cache-Control = %q, want %q", got, "private, max-age=3600")
	}
	if got := fetched.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want %q", got, "nosniff")
	}
	if !bytes.Equal(fetched.Raw, body) {
		t.Errorf("body = %v, want the seeded bytes %v", fetched.Raw, body)
	}

	removed := a.Do(http.MethodDelete, "/api/files/"+docID, cookie, nil)
	if removed.Status != http.StatusOK {
		t.Fatalf("DELETE status = %d, body %s", removed.Status, removed.Raw)
	}
	if removed.JSON["ok"] != true {
		t.Errorf("DELETE body = %v, want {ok:true}", removed.JSON)
	}

	mem := a.Deps.Storage.(*storage.Memory)
	if _, ok := mem.Read(objectKey); ok {
		t.Errorf("object %q still present after delete", objectKey)
	}

	// The row is gone too — a second GET is a clean 404, not a dangling
	// reference to a since-deleted object.
	again := a.Do(http.MethodGet, "/api/files/"+docID, cookie, nil)
	if again.Status != http.StatusNotFound {
		t.Errorf("second GET status = %d, want 404", again.Status)
	}
}

// A document row whose object went missing behind it (deleted straight
// from storage, bypassing the row) must still 404 cleanly — REF: "check
// existence BEFORE streaming" — never a 200 with an empty or broken body.
func TestGetFileMissingObjectBehindRowIs404(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	vaccineID, _ := created.JSON["id"].(string)

	objectKey := "vaccine-docs/" + familyID + "/orphaned"
	docID := seedVaccineDocument(t, a, familyID, vaccineID, objectKey, "card.png", "image/png", pngBytes())

	mem := a.Deps.Storage.(*storage.Memory)
	if err := mem.Delete(context.Background(), objectKey); err != nil {
		t.Fatalf("delete the object behind the row: %v", err)
	}

	res := a.Do(http.MethodGet, "/api/files/"+docID, cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

func TestGetFileUnknownIDIs404(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodGet, "/api/files/does-not-exist", cookie, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}
}

// Another family's file id must 404, not leak whether it exists.
func TestGetFileCrossFamilyIs404(t *testing.T) {
	a := testrig.App(t)
	familyA, cookieA := a.NewFamily("Family A", "a@example.com")
	babyA := a.NewBaby(familyA, "Baby A")
	_, cookieB := a.NewFamily("Family B", "b@example.com")

	created := a.Do(http.MethodPost, "/api/vaccines", cookieA, map[string]any{
		"babyId": babyA, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	vaccineID, _ := created.JSON["id"].(string)
	docID := seedVaccineDocument(t, a, familyA, vaccineID, "vaccine-docs/"+familyA+"/x", "card.png", "image/png", pngBytes())

	res := a.Do(http.MethodGet, "/api/files/"+docID, cookieB, nil)
	if res.Status != http.StatusNotFound {
		t.Fatalf("status = %d, body %s, want 404", res.Status, res.Raw)
	}

	del := a.Do(http.MethodDelete, "/api/files/"+docID, cookieB, nil)
	if del.Status != http.StatusNotFound {
		t.Fatalf("cross-family DELETE status = %d, want 404", del.Status)
	}
}

// Deleting the vaccine log must also remove the stored objects behind its
// documents — the DB row cascades via ON DELETE CASCADE, but the object
// store does not, so internal/api/vaccines.go's DeleteVaccine deletes them
// itself.
func TestDeleteVaccineRemovesStoredObjects(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")

	created := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	vaccineID, _ := created.JSON["id"].(string)

	objectKey := "vaccine-docs/" + familyID + "/seeded-cascade"
	seedVaccineDocument(t, a, familyID, vaccineID, objectKey, "card.png", "image/png", pngBytes())

	del := a.Do(http.MethodDelete, "/api/vaccines/"+vaccineID, cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("DELETE vaccine status = %d, body %s", del.Status, del.Raw)
	}

	mem := a.Deps.Storage.(*storage.Memory)
	if _, ok := mem.Read(objectKey); ok {
		t.Errorf("object %q still present after the vaccine log was deleted", objectKey)
	}
}
