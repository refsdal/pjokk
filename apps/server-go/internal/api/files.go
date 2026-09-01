package api

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/vaccines.ts's filesApp — the
// multipart document-upload route and the /api/files/{id} streaming/delete
// routes. All three are kept OFF the generated strict server (see api.go's
// package doc comment): oapi-codegen's zod-openapi-equivalent route tree is
// JSON-body-in, JSON-body-out, and has no way to express "accept
// multipart/form-data" or "stream an arbitrary binary response" — exactly
// why apps/api's own filesApp is a plain Hono app, never
// `createApp<FamEnv>().openapi(...)` like vaccinesApp. NewHandler
// (api.go) registers the three handlers below directly on its mux, behind
// the identical tierFamily chain (apiKeyAuth, then session, then family)
// every generated tierFamily operation runs behind — apps/api/src/app.ts
// mounts filesApp under the same "/api/*" apiKeyAuth middleware as every
// other route, so this port must too.
//
// # DocumentUploadsEnabled
//
// A photographed helsestasjon (Norwegian health-clinic) card can carry a
// fødselsnummer, and Norwegian law treats that specially — uploads are off
// until the privacy work around it is finished and reviewed (see
// apps/api/src/routes/vaccines.ts's DOCUMENT_UPLOADS_ENABLED comment and
// DECISIONS.md). uploadVaccineDocument below still implements the FULL
// path behind the flag — unknown-entry 404, TOO_MANY, NO_FILE, BAD_TYPE,
// TOO_LARGE, the object-store Put, the document-row insert — because a
// flag flip must not also require rewriting the handler; only the tests
// this port ships can't exercise anything past the flag (it never flips in
// a test). Reading and deleting an already-stored document are NEVER
// gated: disabling uploads must not strand data a family has the right to
// get back and delete.
const DocumentUploadsEnabled = false

const (
	// maxVaccineDocBytes is REF's 10 MiB cap on one uploaded file.
	maxVaccineDocBytes = 10 * 1024 * 1024
	// maxVaccineDocsPerEntry is REF's "at most 5 files per entry".
	maxVaccineDocsPerEntry = 5
	// maxMultipartOverhead is slack above maxVaccineDocBytes for the
	// multipart boundary/headers ParseMultipartForm also has to read, so a
	// file exactly at the cap still parses far enough to hit the explicit
	// size check below (413 TOO_LARGE) instead of failing inside
	// ParseMultipartForm itself (which would otherwise misreport as 400
	// NO_FILE).
	maxMultipartOverhead = 1 << 20 // 1 MiB
)

// allowedVaccineDocTypes is what a phone camera and a helsestasjon card
// actually produce (REF: "jpeg/png/webp/heic/heif/pdf"). Anything else is
// refused outright rather than stored and served back later.
var allowedVaccineDocTypes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/webp":      true,
	"image/heic":      true,
	"image/heif":      true,
	"application/pdf": true,
}

// internalError logs err server-side (naming the request that hit it, like
// responseErrorHandler does for the generated routes) and writes the same
// {"error":"Internal error","code":"INTERNAL"} envelope every other
// unexpected-failure path in this package uses.
func internalError(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("api: %s %s: %v", r.Method, r.URL.Path, err)
	respond.Error(w, http.StatusInternalServerError, "Internal error", "INTERNAL")
}

// uploadVaccineDocument implements POST /api/vaccines/{id}/documents. REF:
// "multipart file. DOCUMENT_UPLOADS_ENABLED = false → always 403
// FEATURE_DISABLED. Behind the flag: 404 unknown entry, 400 TOO_MANY (>5),
// 400 NO_FILE, 415 BAD_TYPE, 413 TOO_LARGE. Key =
// vaccine-docs/{familyId}/{uuid}". See this file's doc comment for why the
// full path below is real code, not exercised by any test while the flag
// is off.
func (d Deps) uploadVaccineDocument(w http.ResponseWriter, r *http.Request) {
	if !DocumentUploadsEnabled {
		respond.Error(w, http.StatusForbidden, "Attachments are disabled", "FEATURE_DISABLED")
		return
	}

	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	id := r.PathValue("id")

	if _, err := d.Q.GetVaccine(ctx, dbgen.GetVaccineParams{FamilyID: fam.FamilyID, ID: id}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
			return
		}
		internalError(w, r, err)
		return
	}

	count, err := d.Q.CountVaccineDocuments(ctx, dbgen.CountVaccineDocumentsParams{FamilyID: fam.FamilyID, VaccineLogID: id})
	if err != nil {
		internalError(w, r, err)
		return
	}
	if count >= maxVaccineDocsPerEntry {
		respond.Error(w, http.StatusBadRequest, "At most 5 files per entry", "TOO_MANY")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxVaccineDocBytes+maxMultipartOverhead)
	if err := r.ParseMultipartForm(maxVaccineDocBytes); err != nil {
		// A grossly oversized body blows through MaxBytesReader's cap
		// before FormFile ever sees a Size to compare against
		// maxVaccineDocBytes below — distinguish that from an ordinary
		// malformed/missing part the same way patch.go's withRawBody does,
		// rather than reporting NO_FILE for a file that was simply too
		// large to finish reading.
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
	defer file.Close()

	contentType := header.Header.Get("Content-Type")
	if !allowedVaccineDocTypes[contentType] {
		respond.Error(w, http.StatusUnsupportedMediaType, "Images and PDFs only", "BAD_TYPE")
		return
	}
	if header.Size <= 0 || header.Size > maxVaccineDocBytes {
		respond.Error(w, http.StatusRequestEntityTooLarge, "File too large", "TOO_LARGE")
		return
	}

	// The key is server-generated: a filename from the client never
	// reaches the object store.
	objectKey := "vaccine-docs/" + fam.FamilyID + "/" + uuid.NewString()
	if err := d.Storage.Put(ctx, objectKey, file, header.Size, contentType); err != nil {
		internalError(w, r, err)
		return
	}

	// Only ever shown as text, never used as a path — see the object key
	// above for the value that actually addresses storage.
	storedFilename := header.Filename
	if len(storedFilename) > 200 {
		storedFilename = storedFilename[:200]
	}
	if storedFilename == "" {
		storedFilename = "document"
	}

	docID, err := d.Q.CreateVaccineDocument(ctx, dbgen.CreateVaccineDocumentParams{
		FamilyID:     fam.FamilyID,
		VaccineLogID: id,
		ObjectKey:    objectKey,
		Filename:     storedFilename,
		ContentType:  contentType,
		Size:         int32(header.Size),
		UploadedBy:   fam.UserID,
	})
	if err != nil {
		internalError(w, r, err)
		return
	}

	respond.JSON(w, http.StatusCreated, map[string]any{
		"id":          docID,
		"filename":    header.Filename,
		"contentType": contentType,
		"size":        header.Size,
		"url":         "/api/files/" + docID,
	})
}

// getFile implements GET /api/files/{id}. REF: "streams
// storage.GetStream(objectKey); headers: content-type, content-length,
// content-disposition: attachment; filename="…" (quotes stripped; never
// inline), cache-control: private, max-age=3600, x-content-type-options:
// nosniff. 404 row-missing or object-missing (check existence BEFORE
// streaming)".
//
// "Check existence BEFORE streaming" is why GetStream's found flag is
// tested, and the 404 written, before any header is set or WriteHeader
// called: an object that went missing behind an otherwise-valid row must
// still 404 cleanly rather than starting a 200 response with no body.
func (d Deps) getFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	id := r.PathValue("id")

	doc, err := d.Q.GetVaccineDocument(ctx, dbgen.GetVaccineDocumentParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
			return
		}
		internalError(w, r, err)
		return
	}

	body, found, err := d.Storage.GetStream(ctx, doc.ObjectKey)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !found {
		respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
		return
	}
	defer body.Close()

	h := w.Header()
	h.Set("Content-Type", doc.ContentType)
	h.Set("Content-Length", strconv.Itoa(int(doc.Size)))
	// Never inline: an uploaded file is untrusted content and must not
	// execute in the app's origin.
	h.Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(doc.Filename, `"`, "")+`"`)
	h.Set("Cache-Control", "private, max-age=3600")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

// deleteFile implements DELETE /api/files/{id}. REF: "{ok:true}; deletes
// object". Never gated: a downgraded family must still be able to delete
// files.
func (d Deps) deleteFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fam := middleware.FamilyFromContext(ctx)
	id := r.PathValue("id")

	objectKey, err := d.Q.DeleteVaccineDocument(ctx, dbgen.DeleteVaccineDocumentParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respond.Error(w, http.StatusNotFound, "Not found", "NOT_FOUND")
			return
		}
		internalError(w, r, err)
		return
	}

	if err := d.Storage.Delete(ctx, objectKey); err != nil {
		internalError(w, r, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// mountFileRoutes registers this file's three hand-routed handlers on mux,
// each wrapped in chain (the tierFamily middleware chain NewHandler builds
// — see api.go). Split out from NewHandler for the same reason
// api.go's route registration comment gives for the generated routes:
// one place names every hand-routed path, independent of how NewHandler
// happens to be laid out around it.
func (d Deps) mountFileRoutes(mux *http.ServeMux, chain func(http.Handler) http.Handler) {
	mux.Handle("POST /api/vaccines/{id}/documents", chain(http.HandlerFunc(d.uploadVaccineDocument)))
	mux.Handle("GET /api/files/{id}", chain(http.HandlerFunc(d.getFile)))
	mux.Handle("DELETE /api/files/{id}", chain(http.HandlerFunc(d.deleteFile)))
}
