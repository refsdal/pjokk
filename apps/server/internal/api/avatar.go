package api

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png" // register the PNG decoder for image.Decode
	"io"
	"log"
	"net/http"
	"path"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Avatar routes (spec §2): hand-mounted like the vaccine-document routes in
// files.go, because the strict server has no way to say "multipart in" or
// "JPEG out". Session tier, family NOT required — a profile is global — and
// API keys are refused: an integration has no profile to edit and no need to
// read faces.
//
//   PUT    /api/me/avatar           multipart field "file" → Me
//   DELETE /api/me/avatar           → Me
//   GET    /api/users/{id}/avatar   image/jpeg; 404 unless self or co-member
//
// Whatever arrives is DECODED and RE-ENCODED as JPEG (normalizeAvatar): that
// proves the bytes are an image regardless of the declared content type,
// bounds the pixel count before a full decode, and strips every byte of
// metadata a camera would have embedded — a JPEG written from pixels
// carries no EXIF, so no GPS fix ever reaches the object store.

const (
	// maxAvatarBytes caps the upload (the client resizes to 512 px JPEG
	// first, which lands well under this).
	maxAvatarBytes = 512 * 1024
	// maxAvatarEdge caps width and height, checked from the header alone.
	maxAvatarEdge = 1024
	// avatarJPEGQuality is the re-encode quality.
	avatarJPEGQuality = 85
)

var (
	errBadImage = errors.New("avatar: not a JPEG or PNG image")
	errTooLarge = errors.New("avatar: image exceeds the size limit")
)

// normalizeAvatar decodes src (JPEG or PNG) and returns it as JPEG bytes,
// flattened onto white so a transparent PNG does not come out black.
// DecodeConfig reads only the header, so an oversized image is refused
// without allocating its pixels.
func normalizeAvatar(src []byte) ([]byte, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil || (format != "jpeg" && format != "png") {
		return nil, errBadImage
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxAvatarEdge || cfg.Height > maxAvatarEdge {
		return nil, errTooLarge
	}
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, errBadImage
	}
	bounds := img.Bounds()
	flat := image.NewRGBA(bounds)
	draw.Draw(flat, bounds, image.White, image.Point{}, draw.Src)
	draw.Draw(flat, bounds, img, bounds.Min, draw.Over)

	var out bytes.Buffer
	if err := jpeg.Encode(&out, flat, &jpeg.Options{Quality: avatarJPEGQuality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// storeAvatar writes jpg under a fresh key, points the user at it, and
// deletes the previous object best-effort (a leaked old object is a
// housekeeping problem; a user without their new photo is a bug). Shared by
// the upload route and the Google import.
func (d Deps) storeAvatar(ctx context.Context, userID string, jpg []byte) (string, error) {
	previous, err := d.Q.GetUserProfile(ctx, userID)
	if err != nil {
		return "", err
	}
	key := "avatars/" + userID + "/" + uuid.NewString() + ".jpg"
	if err := d.Storage.Put(ctx, key, bytes.NewReader(jpg), int64(len(jpg)), "image/jpeg"); err != nil {
		return "", err
	}
	if err := d.Q.SetUserAvatar(ctx, dbgen.SetUserAvatarParams{ID: userID, AvatarKey: &key}); err != nil {
		return "", err
	}
	if previous.AvatarKey != nil && *previous.AvatarKey != key {
		if err := d.Storage.Delete(ctx, *previous.AvatarKey); err != nil {
			log.Printf("api: delete previous avatar %s: %v", *previous.AvatarKey, err)
		}
	}
	return key, nil
}

func (d Deps) putAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session := middleware.SessionFromContext(ctx)

	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes+maxMultipartOverhead)
	if err := r.ParseMultipartForm(maxAvatarBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
			return
		}
		respond.Error(w, http.StatusBadRequest, "No file", "NO_FILE")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		respond.Error(w, http.StatusBadRequest, "No file", "NO_FILE")
		return
	}
	defer func() { _ = file.Close() }()
	if header.Size <= 0 || header.Size > maxAvatarBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
		return
	}
	src, err := io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if len(src) > maxAvatarBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
		return
	}

	jpg, err := normalizeAvatar(src)
	switch {
	case errors.Is(err, errTooLarge):
		respond.Error(w, http.StatusRequestEntityTooLarge, "Image too large — at most 1024 px on either side", "TOO_LARGE")
		return
	case err != nil:
		respond.Error(w, http.StatusUnsupportedMediaType, "JPEG or PNG only", "BAD_TYPE")
		return
	}

	if _, err := d.storeAvatar(ctx, session.UserID, jpg); err != nil {
		internalError(w, r, err)
		return
	}
	me, err := d.buildMe(ctx, session)
	if err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, me)
}

func (d Deps) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	session := middleware.SessionFromContext(ctx)

	profile, err := d.Q.GetUserProfile(ctx, session.UserID)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if profile.AvatarKey != nil {
		// Delete the object BEFORE clearing the key. If Storage.Delete fails,
		// return without touching the row: the key stays in place, so a
		// retried DELETE sees the same AvatarKey and tries the object again
		// instead of reporting success while an orphaned object lingers
		// forever in the store.
		if err := d.Storage.Delete(ctx, *profile.AvatarKey); err != nil {
			internalError(w, r, err)
			return
		}
		if err := d.Q.SetUserAvatar(ctx, dbgen.SetUserAvatarParams{ID: session.UserID, AvatarKey: nil}); err != nil {
			internalError(w, r, err)
			return
		}
	}
	me, err := d.buildMe(ctx, session)
	if err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, me)
}

func (d Deps) getUserAvatar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	target := r.PathValue("id")

	var key *string
	var err error
	if dev := middleware.DeviceFromContext(ctx); dev != nil {
		// A kiosk sees the faces of its own family's members, nobody else's.
		key, err = d.Q.GetAvatarForFamilyMember(ctx, dbgen.GetAvatarForFamilyMemberParams{TargetID: target, FamilyID: dev.FamilyID})
	} else {
		viewer := middleware.SessionFromContext(ctx)
		key, err = d.Q.GetAvatarForViewer(ctx, dbgen.GetAvatarForViewerParams{TargetID: target, ViewerID: viewer.UserID})
	}
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && key == nil) {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}

	etag := `"` + path.Base(*key) + `"`
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	body, found, err := d.Storage.GetStream(ctx, *key)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !found {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	defer func() { _ = body.Close() }()

	h := w.Header()
	h.Set("Content-Type", "image/jpeg")
	h.Set("ETag", etag)
	// The URL carries the key as ?v=, so a long private cache is safe.
	h.Set("Cache-Control", "private, max-age=86400")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

// sessionChain is the hand-routed twin of authChain's tierSession — WITHOUT
// captureHTTP (no avatar route writes a session-refresh cookie) and WITH
// RejectAPIKey: apiKey → session → requireSession → rejectAPIKey.
func sessionChain(d Deps) func(http.Handler) http.Handler {
	mwDeps := d.mwDeps()
	apiKey := middleware.APIKeyAuth(mwDeps)
	session := middleware.Session(mwDeps)
	requireSession := middleware.RequireSession()
	rejectAPIKey := middleware.RejectAPIKey()
	return func(h http.Handler) http.Handler {
		return apiKey(session(requireSession(rejectAPIKey(h))))
	}
}

// avatarReadChain is sessionChain for the avatar READ only, which a kiosk
// device also needs: its caretaker row shows the family's faces
// (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md §4). A device
// has no session, so the gate accepts either; getUserAvatar then scopes a
// device to members of its own family. Upload and delete stay on
// sessionChain — they are a person's, not the family's.
func avatarReadChain(d Deps) func(http.Handler) http.Handler {
	mwDeps := d.mwDeps()
	apiKey := middleware.APIKeyAuth(mwDeps)
	device := middleware.DeviceAuth(mwDeps)
	session := middleware.Session(mwDeps)
	rejectAPIKey := middleware.RejectAPIKey()
	sessionOrDevice := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if middleware.SessionFrom(r) == nil && !middleware.IsDevice(r) {
				respond.Error(w, http.StatusUnauthorized, "Not signed in", "UNAUTHENTICATED")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	return func(h http.Handler) http.Handler {
		return apiKey(device(session(sessionOrDevice(rejectAPIKey(h)))))
	}
}

// mountAvatarRoutes registers the three avatar handlers on mux: the upload
// and delete behind chain, the read behind readChain.
func (d Deps) mountAvatarRoutes(mux *http.ServeMux, chain, readChain func(http.Handler) http.Handler) {
	mux.Handle("PUT /api/me/avatar", chain(http.HandlerFunc(d.putAvatar)))
	mux.Handle("DELETE /api/me/avatar", chain(http.HandlerFunc(d.deleteAvatar)))
	mux.Handle("GET /api/users/{id}/avatar", readChain(http.HandlerFunc(d.getUserAvatar)))
}
