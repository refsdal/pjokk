package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/diapers.ts (REF §A1: "same skeleton"
// as feeds.ts, minus the feed-only columns). Read feeds.go first — its
// package doc comment documents, in full, the PATCH tri-state pattern
// (patch.go's withRawBody/rawBodyFields/patchField) this file reuses
// verbatim for `notes`, the one clearable field diaper_log has.

func serDiaperRow(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, typ string, notes *string) gen.DiaperLog {
	return gen.DiaperLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Notes:         notes,
		Time:          t.Time,
		Type:          gen.DiaperLogType(typ),
	}
}

func serDiaper(row dbgen.GetDiaperRow) gen.DiaperLog {
	return serDiaperRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type, row.Notes)
}

func serDiaperListRow(row dbgen.ListDiapersRow) gen.DiaperLog {
	return serDiaperRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type, row.Notes)
}

// ListDiapers implements GET /api/diapers. REF: "DiaperLog[] newest first".
func (d Deps) ListDiapers(ctx context.Context, req gen.ListDiapersRequestObject) (gen.ListDiapersResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	limit := int32(listFeedsDefaultLimit)
	if req.Params.Limit != nil {
		limit = int32(*req.Params.Limit)
	}

	rows, err := d.Q.ListDiapers(ctx, dbgen.ListDiapersParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.DiaperLog, len(rows))
	for i, row := range rows {
		out[i] = serDiaperListRow(row)
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

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: body.BabyId}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.CreateDiaper404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	id, err := d.Q.CreateDiaper(ctx, dbgen.CreateDiaperParams{
		FamilyID:    fam.FamilyID,
		BabyID:      body.BabyId,
		CaretakerID: fam.UserID,
		Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
		Type:        string(body.Type),
		Notes:       body.Notes,
	})
	if err != nil {
		return nil, err
	}

	created, err := d.Q.GetDiaper(ctx, dbgen.GetDiaperParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateDiaper201JSONResponse(serDiaper(created)), nil
}

// UpdateDiaper implements PATCH /api/diapers/{id}. REF: "partial (nullable
// clears) → DiaperLog / 404". See feeds.go's package doc comment for the
// presence-detection pattern below.
func (d Deps) UpdateDiaper(ctx context.Context, req gen.UpdateDiaperRequestObject) (gen.UpdateDiaperResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	existing, err := d.Q.GetDiaper(ctx, dbgen.GetDiaperParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateDiaper404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateDiaper")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	typeSet, typeVal, err := patchField[string](fields, "type")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}

	if !timeSet && !typeSet && !notesSet {
		return gen.UpdateDiaper200JSONResponse(serDiaper(existing)), nil
	}

	var timeParam pgtype.Timestamptz
	if timeVal != nil {
		timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
	}

	if _, err := d.Q.UpdateDiaper(ctx, dbgen.UpdateDiaperParams{
		FamilyID: fam.FamilyID,
		ID:       req.Id,
		TimeSet:  timeSet,
		TimeVal:  timeParam,
		TypeSet:  typeSet,
		TypeVal:  typeVal,
		NotesSet: notesSet,
		NotesVal: notesVal,
	}); err != nil {
		return nil, err
	}

	updated, err := d.Q.GetDiaper(ctx, dbgen.GetDiaperParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.UpdateDiaper200JSONResponse(serDiaper(updated)), nil
}

// DeleteDiaper implements DELETE /api/diapers/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteDiaper(ctx context.Context, req gen.DeleteDiaperRequestObject) (gen.DeleteDiaperResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteDiaper(ctx, dbgen.DeleteDiaperParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteDiaper404JSONResponse(notFound()), nil
	}
	return gen.DeleteDiaper200JSONResponse{Ok: gen.OkOkTrue}, nil
}
