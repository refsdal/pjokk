package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "measurements" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — `type` and `value` are required and NOT nullable
// (settable or omitted, never cleared). `value` is double precision
// end-to-end: the OpenAPI schema carries `format: double` (Task 12 added
// this — a bare `type: number` defaults to Go float32 in oapi-codegen,
// which would round-trip 8.4 lossily), sqlc's column is `double precision`,
// and both generated Go types land on float64 with no narrowing conversion
// anywhere in this file. See other_logs.go's package doc comment for the
// shared createLog/updateLog/deleteLog engine and medicine.go for a fuller
// worked example of the PATCH tri-state pattern.

func serMeasurement(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, typ string, value float64, notes *string) gen.MeasurementLog {
	return gen.MeasurementLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Type:          gen.MeasurementLogType(typ),
		Value:         value,
		Notes:         notes,
	}
}

// ListMeasurements implements GET /api/measurements. REF: "MeasurementLog[] newest first".
func (d Deps) ListMeasurements(ctx context.Context, req gen.ListMeasurementsRequestObject) (gen.ListMeasurementsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListMeasurements(ctx, dbgen.ListMeasurementsParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.MeasurementLog, len(rows))
	for i, row := range rows {
		out[i] = serMeasurement(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type, row.Value, row.Notes)
	}
	return gen.ListMeasurements200JSONResponse(out), nil
}

// CreateMeasurement implements POST /api/measurements. REF: "{babyId, time,
// type, value, notes?} → 201 / 404 unknown baby". Free in Go (see
// other_logs.go's doc comment).
func (d Deps) CreateMeasurement(ctx context.Context, req gen.CreateMeasurementRequestObject) (gen.CreateMeasurementResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateMeasurement")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateMeasurement(ctx, dbgen.CreateMeasurementParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
				Type:        string(body.Type),
				Value:       body.Value,
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetMeasurementRow, error) {
			return d.Q.GetMeasurement(ctx, dbgen.GetMeasurementParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateMeasurement404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreateMeasurement201JSONResponse(serMeasurement(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type, row.Value, row.Notes)), nil
}

// UpdateMeasurement implements PATCH /api/measurements/{id}. REF: "partial
// (nullable clears) → MeasurementLog / 404".
func (d Deps) UpdateMeasurement(ctx context.Context, req gen.UpdateMeasurementRequestObject) (gen.UpdateMeasurementResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateMeasurement")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	typeSet, typeVal, err := patchField[string](fields, "type")
	if err != nil {
		return nil, err
	}
	valueSet, valueVal, err := patchField[float64](fields, "value")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || typeSet || valueSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetMeasurementRow, error) {
			return d.Q.GetMeasurement(ctx, dbgen.GetMeasurementParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdateMeasurement(ctx, dbgen.UpdateMeasurementParams{
				FamilyID: fam.FamilyID,
				ID:       req.Id,
				TimeSet:  timeSet,
				TimeVal:  timeParam,
				TypeSet:  typeSet,
				TypeVal:  typeVal,
				ValueSet: valueSet,
				ValueVal: valueVal,
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
		return gen.UpdateMeasurement404JSONResponse(notFound()), nil
	}
	return gen.UpdateMeasurement200JSONResponse(serMeasurement(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type, row.Value, row.Notes)), nil
}

// DeleteMeasurement implements DELETE /api/measurements/{id}. REF:
// "{ok:true} / 404".
func (d Deps) DeleteMeasurement(ctx context.Context, req gen.DeleteMeasurementRequestObject) (gen.DeleteMeasurementResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteMeasurement(ctx, dbgen.DeleteMeasurementParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteMeasurement404JSONResponse(notFound()), nil
	}
	return gen.DeleteMeasurement200JSONResponse{Ok: gen.OkOkTrue}, nil
}
