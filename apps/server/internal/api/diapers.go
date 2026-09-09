package api

import (
	"context"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/diapers.ts (REF §A1: "same skeleton"
// as feeds.ts, minus the feed-only columns). Read feeds.go first — its
// package doc comment documents, in full, the PATCH tri-state pattern
// (patch.go's withRawBody/patchBody/patchField) this file reuses
// verbatim for `notes`, the one clearable field diaper_log has.

func serDiaper(row dbgen.GetDiaperRow) gen.DiaperLog {
	return gen.DiaperLog{
		Id:            row.ID,
		BabyId:        row.BabyID,
		CaretakerId:   row.CaretakerID,
		CaretakerName: row.CaretakerName,
		Notes:         row.Notes,
		Time:          row.Time.Time,
		Type:          gen.DiaperLogType(row.Type),
		Color:         enumPtr[gen.DiaperLogColor](row.Color),
		Consistency:   enumPtr[gen.DiaperLogConsistency](row.Consistency),
	}
}

// ListDiapers implements GET /api/diapers. REF: "DiaperLog[] newest first".
func (d Deps) ListDiapers(ctx context.Context, req gen.ListDiapersRequestObject) (gen.ListDiapersResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	rows, err := d.Q.ListDiapers(ctx, dbgen.ListDiapersParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.DiaperLog, len(rows))
	for i, row := range rows {
		out[i] = serDiaper(dbgen.GetDiaperRow(row))
	}
	return gen.ListDiapers200JSONResponse(out), nil
}

// CreateDiaper implements POST /api/diapers. REF: "{babyId, time, type,
// notes?} → 201 / 404 unknown baby".
func (d Deps) CreateDiaper(ctx context.Context, req gen.CreateDiaperRequestObject) (gen.CreateDiaperResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateDiaper")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateDiaper(ctx, dbgen.CreateDiaperParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        ts(body.Time),
				Type:        string(body.Type),
				Color:       enumStr(body.Color),
				Consistency: enumStr(body.Consistency),
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetDiaperRow, error) {
			return d.Q.GetDiaper(ctx, dbgen.GetDiaperParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateDiaper404JSONResponse(unknownBabyErr()), nil
	}
	return gen.CreateDiaper201JSONResponse(serDiaper(row)), nil
}

// UpdateDiaper implements PATCH /api/diapers/{id}. REF: "partial (nullable
// clears) → DiaperLog / 404". See feeds.go's package doc comment for the
// presence-detection pattern below.
func (d Deps) UpdateDiaper(ctx context.Context, req gen.UpdateDiaperRequestObject) (gen.UpdateDiaperResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	p, err := patchBody(ctx, "UpdateDiaper")
	if err != nil {
		return nil, err
	}

	timeSet, timeVal := patchField[time.Time](p, "time")
	typeSet, typeVal := patchField[string](p, "type")
	colorSet, colorVal := patchField[string](p, "color")
	consistencySet, consistencyVal := patchField[string](p, "consistency")
	notesSet, notesVal := patchField[string](p, "notes")

	if err := p.Err(); err != nil {
		return nil, err
	}

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetDiaperRow, error) {
			return d.Q.GetDiaper(ctx, dbgen.GetDiaperParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateDiaper(ctx, dbgen.UpdateDiaperParams{
				FamilyID:       fam.FamilyID,
				ID:             req.Id,
				TimeSet:        timeSet,
				TimeVal:        tsFrom(timeVal),
				TypeSet:        typeSet,
				TypeVal:        typeVal,
				ColorSet:       colorSet,
				ColorVal:       colorVal,
				ConsistencySet: consistencySet,
				ConsistencyVal: consistencyVal,
				NotesSet:       notesSet,
				NotesVal:       notesVal,
			})
			return err
		},
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return gen.UpdateDiaper404JSONResponse(notFound()), nil
	}
	return gen.UpdateDiaper200JSONResponse(serDiaper(row)), nil
}

// DeleteDiaper implements DELETE /api/diapers/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteDiaper(ctx context.Context, req gen.DeleteDiaperRequestObject) (gen.DeleteDiaperResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteDiaper(ctx, dbgen.DeleteDiaperParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteDiaper404JSONResponse(notFound()), nil
	}
	return gen.DeleteDiaper200JSONResponse{Ok: gen.OkOkTrue}, nil
}
