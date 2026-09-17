package api

import (
	"errors"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Baby photos: avatar.go transposed onto the baby (00032_baby_avatar.sql).
// Hand-mounted for the same reason — multipart in, JPEG out — but a baby is
// the FAMILY's, so these run behind the family fence rather than the
// session tier, and the read is open to the family's kiosk device, whose
// care station shows the baby's face.
//
//	PUT    /api/babies/{id}/avatar   multipart field "file" → Baby
//	DELETE /api/babies/{id}/avatar   → Baby
//	GET    /api/babies/{id}/avatar   image/jpeg; 404 unless in the caller's family
//
// Any member may set or clear the photo, the rule UpdateBaby already
// applies to the baby's details. Never an API key (an integration has no
// need to see or set faces) and never a device for the writes.
//
// The bytes go through normalizeAvatar exactly as a person's do: decoded
// and re-encoded, so no EXIF reaches the store. The key lives under its own
// prefix, which the nightly photo backup (jobs/photo_backup.go) covers —
// unlike a person's photo, a baby's is family data a restore brings back.

const babyAvatarPrefix = "baby-avatars/"

func babyAvatarURL(babyID string, key *string) *string {
	if key == nil || *key == "" {
		return nil
	}
	u := "/api/babies/" + babyID + "/avatar?v=" + avatarVersion(*key)
	return &u
}

func (d Deps) putBabyAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	babyID := r.PathValue("id")

	// The fence before the bytes: a stranger's upload must cost no decode
	// and leave no object.
	existing, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: babyID})
	if errors.Is(err, pgx.ErrNoRows) {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}

	jpg, ok := readAvatarUpload(w, r)
	if !ok {
		return
	}

	key := babyAvatarPrefix + fam.FamilyID + "/" + uuid.NewString() + ".jpg"
	if err := d.Storage.Put(ctx, key, bytesReader(jpg), int64(len(jpg)), "image/jpeg"); err != nil {
		internalError(w, r, err)
		return
	}
	updated, err := d.Q.SetBabyAvatar(ctx, dbgen.SetBabyAvatarParams{FamilyID: fam.FamilyID, ID: babyID, AvatarKey: &key})
	if err != nil {
		internalError(w, r, err)
		return
	}
	// The previous object goes best-effort, as storeAvatar does: a leaked
	// object is the photo backup's orphan sweep to finish, a baby without
	// her new photo would be a bug.
	if existing.AvatarKey != nil && *existing.AvatarKey != key {
		if err := d.Storage.Delete(ctx, *existing.AvatarKey); err != nil {
			log.Printf("api: delete previous baby avatar %s: %v", *existing.AvatarKey, err)
		}
	}
	respond.JSON(w, http.StatusOK, serBaby(updated))
}

func (d Deps) deleteBabyAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	babyID := r.PathValue("id")

	baby, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: babyID})
	if errors.Is(err, pgx.ErrNoRows) {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	if baby.AvatarKey != nil {
		// Object before row, as deleteAvatar orders it: a failed delete
		// leaves the key in place for the retry.
		if err := d.Storage.Delete(ctx, *baby.AvatarKey); err != nil {
			internalError(w, r, err)
			return
		}
		baby, err = d.Q.SetBabyAvatar(ctx, dbgen.SetBabyAvatarParams{FamilyID: fam.FamilyID, ID: babyID, AvatarKey: nil})
		if err != nil {
			internalError(w, r, err)
			return
		}
	}
	respond.JSON(w, http.StatusOK, serBaby(baby))
}

func (d Deps) getBabyAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// A session's active family or the device's own: RequireFamily resolved
	// whichever it was.
	fam := middleware.FamilyFromContext(ctx)
	key, err := d.Q.GetBabyAvatarKey(ctx, dbgen.GetBabyAvatarKeyParams{FamilyID: fam.FamilyID, ID: r.PathValue("id")})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && key == nil) {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	d.streamAvatar(w, r, *key)
}

// babyAvatarChains are the two chains the routes above run behind. Writes:
// familyChain plus RejectAPIKey. Reads: the same with DeviceAuth ahead of
// the session, so RequireFamily resolves a kiosk device to its own family
// (middleware.deviceFamily) — the one hand-routed family route a device
// may call, for the face on its care station.
func babyAvatarChains(d Deps) (write, read func(http.Handler) http.Handler) {
	mwDeps := d.mwDeps()
	apiKey := middleware.APIKeyAuth(mwDeps)
	device := middleware.DeviceAuth(mwDeps)
	session := middleware.Session(mwDeps)
	family := middleware.RequireFamily(mwDeps)
	rejectAPIKey := middleware.RejectAPIKey()
	write = func(h http.Handler) http.Handler { return apiKey(session(family(rejectAPIKey(h)))) }
	read = func(h http.Handler) http.Handler { return apiKey(device(session(family(rejectAPIKey(h))))) }
	return write, read
}

func (d Deps) mountBabyAvatarRoutes(mux *http.ServeMux, write, read func(http.Handler) http.Handler) {
	mux.Handle("PUT /api/babies/{id}/avatar", write(http.HandlerFunc(d.putBabyAvatar)))
	mux.Handle("DELETE /api/babies/{id}/avatar", write(http.HandlerFunc(d.deleteBabyAvatar)))
	mux.Handle("GET /api/babies/{id}/avatar", read(http.HandlerFunc(d.getBabyAvatar)))
}
