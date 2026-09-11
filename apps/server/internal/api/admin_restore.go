package api

// The console's family restore (docs/superpowers/specs/2026-09-11-admin-restore-design.md
// §3): which families a nightly snapshot holds that no longer exist, and
// bringing one back. The work is internal/restore's, the same code
// `pjokk restore family` runs.

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/restore"
)

func (d Deps) restoreDeps() restore.Deps {
	return restore.Deps{Pool: d.Pool, Storage: d.Storage}
}

func noSnapshot() gen.Error {
	return gen.Error{Error: "No snapshot for that date", Code: "NOT_FOUND"}
}

// familyDeletion is who deleted a family from the console, and when.
type familyDeletion struct {
	at time.Time
	by string
}

// familyDeletions reads the family.delete audit rows for ids — the
// console's delete is the only path that removes a family, so an operator
// can see whose mistake they are undoing.
func (d Deps) familyDeletions(ctx context.Context, ids []string) (map[string]familyDeletion, error) {
	out := map[string]familyDeletion{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := d.Pool.Query(ctx, `
		SELECT DISTINCT ON (a."target") a."target", a."created_at", COALESCE(u."display_name", u."email", '')
		FROM "admin_audit" a
		LEFT JOIN "users" u ON u."id" = a."admin_id"
		WHERE a."action" = 'family.delete' AND a."target" = ANY($1)
		ORDER BY a."target", a."created_at" DESC`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var del familyDeletion
		if err := rows.Scan(&id, &del.at, &del.by); err != nil {
			return nil, err
		}
		out[id] = del
	}
	return out, rows.Err()
}

func (d Deps) ListDeletedFamilies(ctx context.Context, req gen.ListDeletedFamiliesRequestObject) (gen.ListDeletedFamiliesResponseObject, error) {
	snap, err := restore.FromStorage(ctx, d.Storage, string(req.Date))
	if errors.Is(err, restore.ErrNoSnapshot) {
		return gen.ListDeletedFamilies404JSONResponse(noSnapshot()), nil
	}
	if err != nil {
		return nil, err
	}
	gone, err := restore.DeletedFamilies(ctx, d.Pool, snap)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(gone))
	for i, f := range gone {
		ids[i] = f.ID
	}
	deletions, err := d.familyDeletions(ctx, ids)
	if err != nil {
		return nil, err
	}

	out := make(gen.ListDeletedFamilies200JSONResponse, 0, len(gone))
	for _, f := range gone {
		item := gen.DeletedFamily{Id: f.ID, Name: f.Name, Slug: f.Slug, Members: f.Members, Babies: f.Babies}
		if created, err := time.Parse(time.RFC3339Nano, f.CreatedAt); err == nil {
			item.CreatedAt = &created
		}
		if del, ok := deletions[f.ID]; ok {
			item.DeletedAt = &del.at
			item.DeletedBy = &del.by
		}
		out = append(out, item)
	}
	return out, nil
}

// RestoreDeletedFamily brings one family back. The audit row is written
// inside the restore's transaction, so it exists exactly when the restore
// does — neither a trail entry for a restore that rolled back, nor a
// restore without one.
func (d Deps) RestoreDeletedFamily(ctx context.Context, req gen.RestoreDeletedFamilyRequestObject) (gen.RestoreDeletedFamilyResponseObject, error) {
	admin, err := adminID(ctx)
	if err != nil {
		return nil, err
	}
	date, familyID := string(req.Date), string(req.Id)

	snap, err := restore.FromStorage(ctx, d.Storage, date)
	if errors.Is(err, restore.ErrNoSnapshot) {
		return gen.RestoreDeletedFamily404JSONResponse(noSnapshot()), nil
	}
	if err != nil {
		return nil, err
	}

	rep, err := restore.Family(ctx, d.restoreDeps(), snap, familyID, func(ctx context.Context, tx pgx.Tx) error {
		return audit(ctx, d.Q.WithTx(tx), admin, "family.restore", familyID, "from the snapshot of "+date)
	})
	switch {
	case errors.Is(err, restore.ErrFamilyExists):
		return gen.RestoreDeletedFamily409JSONResponse{Error: "That family exists — only a deleted family can be restored", Code: "FAMILY_EXISTS"}, nil
	case errors.Is(err, restore.ErrNewerSnapshot):
		return gen.RestoreDeletedFamily409JSONResponse{Error: "That snapshot is from a newer schema than this build", Code: "SNAPSHOT_NEWER"}, nil
	case errors.Is(err, restore.ErrFamilyNotInSnapshot):
		return gen.RestoreDeletedFamily404JSONResponse{Error: "That family is not in the snapshot", Code: "NOT_FOUND"}, nil
	case err != nil && rep == nil:
		return nil, err
	case err != nil:
		// The rows are committed; only copying photos back failed. The
		// family is restored, so say so, and say what went wrong.
		log.Printf("api: restore family %s: %v", familyID, err)
		rep.Warnings = append(rep.Warnings, "Some photos could not be copied back: "+err.Error())
	}

	out := gen.RestoreDeletedFamily200JSONResponse{
		FamilyId:        rep.FamilyID,
		Name:            rep.Name,
		Slug:            rep.Slug,
		PreviousSlug:    orNil(rep.PreviousSlug),
		MembersRejoined: rep.MembersRejoined,
		MembersDropped:  rep.MembersDropped,
		HasAdmin:        rep.HasAdmin,
		Rows:            rep.Rows,
		PhotosRestored:  rep.PhotosRestored,
		PhotosMissing:   rep.PhotosMissing,
		Warnings:        rep.Warnings,
	}
	if out.PhotosMissing == nil {
		out.PhotosMissing = []string{}
	}
	if out.Warnings == nil {
		out.Warnings = []string{}
	}
	return out, nil
}
