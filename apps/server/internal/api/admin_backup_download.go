package api

// GET /api/admin/backups/{date}: one nightly snapshot, downloaded
// (docs/superpowers/specs/2026-09-11-admin-ops-design.md §3).
//
// Hand-routed for the reason the CSV export and the file streams are: a
// streamed body has no place in the JSON-only strict-server tree. It runs
// behind sysadminChain, the same gates every generated tierSysadmin route
// runs behind, and the tier test probes it with the rest.
//
// A snapshot is every table — every family's health data — so the route
// is as narrow as it can be: the audit row is written before the first
// byte, the response is an attachment nothing may cache, and the SPA keeps
// /api/admin/ out of both the service worker's cache and its persisted
// query snapshot.

import (
	"io"
	"log"
	"net/http"
	"regexp"

	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/api/respond"
	"github.com/refsdal/pjokk/server/internal/jobs"
)

// snapshotDatePattern is the only shape a {date} may take: it becomes part
// of an object key, so nothing else — no "..", no extension — reaches
// storage.
var snapshotDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// sysadminChain is authChain's tierSysadmin gates as a standalone wrapper,
// for hand-routed system-admin routes (familyChain's counterpart): an API
// key or a session identifies the caller, and RequireSysadmin answers 401
// without a session, 403 for an API key or anyone who is not a system admin.
func sysadminChain(d Deps) func(http.Handler) http.Handler {
	mwDeps := d.mwDeps()
	apiKey := middleware.APIKeyAuth(mwDeps)
	session := middleware.Session(mwDeps)
	sysadmin := middleware.RequireSysadmin()
	return func(h http.Handler) http.Handler { return apiKey(session(sysadmin(h))) }
}

func (d Deps) mountAdminBackupRoutes(mux *http.ServeMux, chain func(http.Handler) http.Handler) {
	mux.Handle("GET /api/admin/backups/{date}", chain(http.HandlerFunc(d.downloadBackup)))
}

func (d Deps) downloadBackup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	date := r.PathValue("date")
	if !snapshotDatePattern.MatchString(date) {
		respond.Error(w, http.StatusBadRequest, "Not a snapshot date (YYYY-MM-DD)", "VALIDATION")
		return
	}

	// Opened before the audit row: a night with no snapshot is not a
	// download, and should not read as one in the trail.
	body, found, err := d.Storage.GetStream(ctx, jobs.SnapshotKey(date))
	if err != nil {
		log.Printf("api: open snapshot %s: %v", date, err)
		respond.Error(w, http.StatusInternalServerError, "Could not read the snapshot", "INTERNAL")
		return
	}
	if !found {
		respond.Error(w, http.StatusNotFound, "No snapshot for that date", "NOT_FOUND")
		return
	}
	defer func() { _ = body.Close() }()

	admin, err := adminID(ctx)
	if err == nil {
		err = audit(ctx, d.Q, admin, "backup.download", date, "")
	}
	if err != nil {
		log.Printf("api: audit snapshot download %s: %v", date, err)
		respond.Error(w, http.StatusInternalServerError, "Could not record the download", "INTERNAL")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Disposition", `attachment; filename="pjokk-backup-`+date+`.json"`)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}
