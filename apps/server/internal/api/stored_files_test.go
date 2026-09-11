package api_test

// Issue #95: deleting a family or a baby erases its stored files. The rows
// cascade away with the organization or the baby; the objects behind
// milestone_photo and vaccine_document do not, so both deletes read the
// keys first and remove the objects once the rows are gone.

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/storage"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// storedFiles gives babyID a milestone with a photo and a vaccine entry
// with a document, and returns both object keys.
func storedFiles(t *testing.T, a *testrig.AppRig, familyID, cookie, babyID, name string) (photoKey, docKey string) {
	t.Helper()
	milestoneID := newMilestone(t, a, cookie, babyID, "First smile")
	up := photoUpload(t, a, milestoneID, cookie, realPNG(t, 40, 30))
	if up.Status != http.StatusCreated {
		t.Fatalf("upload = %d %s", up.Status, up.Raw)
	}
	photoID, _ := up.JSON["id"].(string)
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "object_key" FROM "milestone_photo" WHERE "id" = $1`, photoID).Scan(&photoKey); err != nil {
		t.Fatalf("photo key: %v", err)
	}

	vaccine := a.Do(http.MethodPost, "/api/vaccines", cookie, map[string]any{
		"babyId": babyID, "time": time.Now().UTC().Format(time.RFC3339), "name": "MMR",
	})
	if vaccine.Status != http.StatusCreated {
		t.Fatalf("create vaccine = %d %s", vaccine.Status, vaccine.Raw)
	}
	vaccineID, _ := vaccine.JSON["id"].(string)
	docKey = "vaccine-docs/" + familyID + "/" + name
	seedVaccineDocument(t, a, familyID, vaccineID, docKey, "card.png", "image/png", pngBytes())
	return photoKey, docKey
}

func allStoredKeys(t *testing.T, mem *storage.Memory) []string {
	t.Helper()
	objs, err := mem.List(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, len(objs))
	for i, o := range objs {
		keys[i] = o.Key
	}
	return keys
}

func TestDeleteFamilyErasesItsStoredFiles(t *testing.T) {
	a, opsFamily, opsCookie, _ := sysadminRig(t, "Ops family")
	mem := a.Deps.Storage.(*storage.Memory)

	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	storedFiles(t, a, familyID, cookie, a.NewBaby(familyID, "Nora"), "nora")
	// The operator's own family is the control: its files stay.
	opsPhoto, opsDoc := storedFiles(t, a, opsFamily, opsCookie, a.NewBaby(opsFamily, "Ola"), "ola")
	if n := len(allStoredKeys(t, mem)); n != 4 {
		t.Fatalf("seeded %d objects, want 4", n)
	}

	res := a.Do(http.MethodDelete, "/api/admin/families/"+familyID, opsCookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("delete family = %d %s", res.Status, res.Raw)
	}

	want := []string{opsDoc, opsPhoto}
	slices.Sort(want)
	if got := allStoredKeys(t, mem); !slices.Equal(got, want) {
		t.Errorf("stored after the delete = %v, want only the other family's %v", got, want)
	}
}

func TestDeleteBabyErasesItsStoredFilesAndSparesASibling(t *testing.T) {
	a := testrig.App(t)
	mem := a.Deps.Storage.(*storage.Memory)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	nora := a.NewBaby(familyID, "Nora")
	noraPhoto, noraDoc := storedFiles(t, a, familyID, cookie, nora, "nora")
	olaPhoto, olaDoc := storedFiles(t, a, familyID, cookie, a.NewBaby(familyID, "Ola"), "ola")

	res := a.Do(http.MethodDelete, "/api/babies/"+nora, cookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("delete baby = %d %s", res.Status, res.Raw)
	}

	for _, key := range []string{noraPhoto, noraDoc} {
		if _, ok := mem.Read(key); ok {
			t.Errorf("%s still stored after its baby was deleted", key)
		}
	}
	for _, key := range []string{olaPhoto, olaDoc} {
		if _, ok := mem.Read(key); !ok {
			t.Errorf("%s (the sibling's) was erased with the other baby", key)
		}
	}
}
