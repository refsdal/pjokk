package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "baths" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — the shortest of the six Phase 3 kinds (no columns
// beyond time/notes). See other_logs.go's package doc comment for the
// shared createLog/updateLog/deleteLog engine and medicine.go for a fuller
// worked example with the PATCH tri-state pattern.

func serBath(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, notes *string) gen.BathLog {
	return gen.BathLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Notes:         notes,
	}
}

// ListBaths implements GET /api/baths. REF: "BathLog[] newest first".
func (d Deps) ListBaths(ctx context.Context, req gen.ListBathsRequestObject) (gen.ListBathsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListBaths(ctx, dbgen.ListBathsParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.BathLog, len(rows))
	for i, row := range rows {
		out[i] = serBath(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Notes)
	}
	return gen.ListBaths200JSONResponse(out), nil
}

// CreateBath implements POST /api/baths. REF: "{babyId, time, notes?} → 201
// / 404 unknown baby". Free in Go (apps/api gated this behind
// "otherActivities"; Task 12 removes it — see other_logs.go's doc comment).
func (d Deps) CreateBath(ctx context.Context, req gen.CreateBathRequestObject) (gen.CreateBathResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateBath")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateBath(ctx, dbgen.CreateBathParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetBathRow, error) {
			return d.Q.GetBath(ctx, dbgen.GetBathParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateBath404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreateBath201JSONResponse(serBath(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Notes)), nil
}

// UpdateBath implements PATCH /api/baths/{id}. REF: "partial (nullable
// clears) → BathLog / 404".
func (d Deps) UpdateBath(ctx context.Context, req gen.UpdateBathRequestObject) (gen.UpdateBathResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateBath")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetBathRow, error) {
			return d.Q.GetBath(ctx, dbgen.GetBathParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdateBath(ctx, dbgen.UpdateBathParams{
				FamilyID: fam.FamilyID,
				ID:       req.Id,
				TimeSet:  timeSet,
				TimeVal:  timeParam,
				NotesSet: notesSet,
				NotesVal: notesVal,
			})
			return err
		},
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return gen.UpdateBath404JSONResponse(notFound()), nil
	}
	return gen.UpdateBath200JSONResponse(serBath(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Notes)), nil
}

// DeleteBath implements DELETE /api/baths/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteBath(ctx context.Context, req gen.DeleteBathRequestObject) (gen.DeleteBathResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteBath(ctx, dbgen.DeleteBathParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteBath404JSONResponse(notFound()), nil
	}
	return gen.DeleteBath200JSONResponse{Ok: gen.OkOkTrue}, nil
}
