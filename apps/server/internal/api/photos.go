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
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Photos on milestones (issue #48). Hand-routed like files.go, because
// multipart in and image bytes out are outside the generated strict
// server's JSON-only shape:
//
//	POST   /api/milestones/{id}/photos  multipart "file" → 201 MilestonePhoto
//	GET    /api/photos/{id}             image/jpeg (inline; the bytes are ours)
//	DELETE /api/photos/{id}             {ok:true}
//	GET    /api/photos/usage            {bytes, quotaBytes}
//
// Every upload is re-encoded on the server, the avatar pipeline's rule
// (avatar.go): DecodeConfig bounds the pixel count from the header before
// anything is allocated, image.Decode proves the bytes really are a JPEG or
// PNG whatever the declared type, and a JPEG written from pixels carries no
// EXIF — no GPS fix ever reaches the object store. That is also why the
// photo route may serve inline where /api/files/{id} must say attachment:
// a stored photo is bytes this server produced, not an uploaded file.
//
// The quota is per family, on the stored (re-encoded) size, summed from
// the rows rather than tracked in a counter that could drift. PhotoQuotaBytes
// is Deps-supplied from PHOTO_QUOTA_MB; zero means no quota.

const (
	// maxPhotoUploadBytes caps one upload. The SPA downscales to 1600 px
	// JPEG first (well under 1 MB); the cap is for a client that does not.
	maxPhotoUploadBytes = 8 * 1024 * 1024
	// maxPhotoEdge caps width and height from the header alone: 3000² is
	// ~36 MB of RGBA, the most one decode is allowed to allocate.
	maxPhotoEdge = 3000
	// maxPhotosPerMilestone keeps an entry a moment, not an album.
	maxPhotosPerMilestone = 3
	photoJPEGQuality      = 82
	photoKeyPrefix        = "milestone-photos/"
)

// normalizePhoto is normalizeAvatar with the photo bounds: JPEG or PNG in,
// flattened JPEG out, plus the stored dimensions.
func normalizePhoto(src []byte) (jpg []byte, width, height int, err error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(src))
	if err != nil || (format != "jpeg" && format != "png") {
		return nil, 0, 0, errBadImage
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxPhotoEdge || cfg.Height > maxPhotoEdge {
		return nil, 0, 0, errTooLarge
	}
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, 0, 0, errBadImage
	}
	bounds := img.Bounds()
	flat := image.NewRGBA(bounds)
	draw.Draw(flat, bounds, image.White, image.Point{}, draw.Src)
	draw.Draw(flat, bounds, img, bounds.Min, draw.Over)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, flat, &jpeg.Options{Quality: photoJPEGQuality}); err != nil {
		return nil, 0, 0, err
	}
	return out.Bytes(), bounds.Dx(), bounds.Dy(), nil
}

func serMilestonePhoto(id string, width, height, size int32) gen.MilestonePhoto {
	return gen.MilestonePhoto{
		Id:     id,
		Width:  width,
		Height: height,
		Size:   size,
		Url:    "/api/photos/" + id,
	}
}

// serMilestonePhotos is always non-nil: MilestoneLog.photos is a required
// array, and a milestone without photos must say `"photos":[]`.
func serMilestonePhotos(rows []dbgen.ListMilestonePhotosForLogRow) []gen.MilestonePhoto {
	out := make([]gen.MilestonePhoto, 0, len(rows))
	for _, r := range rows {
		out = append(out, serMilestonePhoto(r.ID, r.Width, r.Height, r.Size))
	}
	return out
}

// photosByMilestone is the batched hydration for lists and the timeline:
// one query for every id, grouped.
func (d Deps) photosByMilestone(ctx context.Context, familyID string, ids []string) (map[string][]dbgen.ListMilestonePhotosForLogRow, error) {
	byLog := make(map[string][]dbgen.ListMilestonePhotosForLogRow, len(ids))
	if len(ids) == 0 {
		return byLog, nil
	}
	rows, err := d.Q.ListMilestonePhotosForLogs(ctx, dbgen.ListMilestonePhotosForLogsParams{FamilyID: familyID, MilestoneLogIds: ids})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		byLog[r.MilestoneLogID] = append(byLog[r.MilestoneLogID], dbgen.ListMilestonePhotosForLogRow(r))
	}
	return byLog, nil
}

func (d Deps) uploadMilestonePhoto(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	id := r.PathValue("id")

	if _, err := d.Q.GetMilestone(ctx, dbgen.GetMilestoneParams{FamilyID: fam.FamilyID, ID: id}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
			return
		}
		internalError(w, r, err)
		return
	}
	count, err := d.Q.CountMilestonePhotos(ctx, dbgen.CountMilestonePhotosParams{FamilyID: fam.FamilyID, MilestoneLogID: id})
	if err != nil {
		internalError(w, r, err)
		return
	}
	if count >= maxPhotosPerMilestone {
		respond.Error(w, http.StatusBadRequest, "At most 3 photos per milestone", "TOO_MANY")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxPhotoUploadBytes+maxMultipartOverhead)
	if err := r.ParseMultipartForm(maxPhotoUploadBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			respond.Error(w, http.StatusRequestEntityTooLarge, "Photo too large", "TOO_LARGE")
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
	if header.Size <= 0 || header.Size > maxPhotoUploadBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "Photo too large", "TOO_LARGE")
		return
	}
	src, err := io.ReadAll(io.LimitReader(file, maxPhotoUploadBytes+1))
	if err != nil || len(src) > maxPhotoUploadBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "Photo too large", "TOO_LARGE")
		return
	}

	jpg, width, height, err := normalizePhoto(src)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			respond.Error(w, http.StatusRequestEntityTooLarge, "Photo too large", "TOO_LARGE")
			return
		}
		respond.Error(w, http.StatusUnsupportedMediaType, "JPEG or PNG photos only", "BAD_TYPE")
		return
	}

	if d.PhotoQuotaBytes > 0 {
		used, err := d.Q.SumMilestonePhotoBytes(ctx, fam.FamilyID)
		if err != nil {
			internalError(w, r, err)
			return
		}
		if used+int64(len(jpg)) > d.PhotoQuotaBytes {
			respond.Error(w, http.StatusRequestEntityTooLarge, "Photo storage is full", "QUOTA")
			return
		}
	}

	objectKey := photoKeyPrefix + fam.FamilyID + "/" + uuid.NewString() + ".jpg"
	if err := d.Storage.Put(ctx, objectKey, bytes.NewReader(jpg), int64(len(jpg)), "image/jpeg"); err != nil {
		internalError(w, r, err)
		return
	}
	photoID, err := d.Q.CreateMilestonePhoto(ctx, dbgen.CreateMilestonePhotoParams{
		FamilyID:       fam.FamilyID,
		MilestoneLogID: id,
		ObjectKey:      objectKey,
		Width:          int32(width),
		Height:         int32(height),
		Size:           int32(len(jpg)),
	})
	if err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusCreated, serMilestonePhoto(photoID, int32(width), int32(height), int32(len(jpg))))
}

func (d Deps) getMilestonePhoto(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	id := r.PathValue("id")

	photo, err := d.Q.GetMilestonePhoto(ctx, dbgen.GetMilestonePhotoParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
			return
		}
		internalError(w, r, err)
		return
	}
	// The bytes behind an id never change, so the id is the ETag.
	etag := `"` + photo.ID + `"`
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body, found, err := d.Storage.GetStream(ctx, photo.ObjectKey)
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
	h.Set("Content-Length", strconv.Itoa(int(photo.Size)))
	h.Set("ETag", etag)
	h.Set("Cache-Control", "private, max-age=86400")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

func (d Deps) deleteMilestonePhoto(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	id := r.PathValue("id")

	objectKey, err := d.Q.DeleteMilestonePhoto(ctx, dbgen.DeleteMilestonePhotoParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
			return
		}
		internalError(w, r, err)
		return
	}
	// Row first, object second: a failure here leaks an orphan object, never
	// a row pointing at nothing.
	if err := d.Storage.Delete(ctx, objectKey); err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// photoUsage backs Settings → Data's "Photos: 12 MB of 500 MB".
func (d Deps) photoUsage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	used, err := d.Q.SumMilestonePhotoBytes(ctx, fam.FamilyID)
	if err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"bytes": used, "quotaBytes": d.PhotoQuotaBytes})
}

func (d Deps) mountPhotoRoutes(mux *http.ServeMux, chain func(http.Handler) http.Handler) {
	mux.Handle("POST /api/milestones/{id}/photos", chain(http.HandlerFunc(d.uploadMilestonePhoto)))
	// The literal segment wins over the {id} wildcard in net/http's mux.
	mux.Handle("GET /api/photos/usage", chain(http.HandlerFunc(d.photoUsage)))
	mux.Handle("GET /api/photos/{id}", chain(http.HandlerFunc(d.getMilestonePhoto)))
	mux.Handle("DELETE /api/photos/{id}", chain(http.HandlerFunc(d.deleteMilestonePhoto)))
}
