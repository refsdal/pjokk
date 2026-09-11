package api

import (
	"context"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "measurements" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — `type` and `value` are required and NOT nullable
// (settable or omitted, never cleared). `value` is double precision
// end-to-end: the OpenAPI schema carries `format: double` (because a bare
// `type: number` defaults to Go float32 in oapi-codegen,
// which would round-trip 8.4 lossily), sqlc's column is `double precision`,
// and both generated Go types land on float64 with no narrowing conversion
// anywhere in this file. See other_logs.go's package doc comment for the
// shared createLog/updateLog/deleteLog engine and medicine.go for a fuller
// worked example of the PATCH tri-state pattern.

// MeasurementUnit is the canonical unit a measurement's `value` is stored in.
//
// measurement_log deliberately has NO unit column: the unit is a pure
// function of the type, and every row is stored in the canonical unit —
// kilograms, centimetres, degrees Celsius. This is the single seam a future
// units preference (Fahrenheit, pounds) hooks into: it converts for DISPLAY
// at the edge and leaves every stored row and the schema untouched. Do not
// introduce a per-row unit; normalise on the way in instead, the way
// scripts/import-sprout-track.mjs converts sprout's lb and in.
//
// The three-type world could get away with `if weight { kg } else { cm }`.
// A fourth type makes that silently wrong, which is why this is a table.
func MeasurementUnit(typ string) string {
	switch typ {
	case "weight":
		return "kg"
	case "temperature":
		return "°C"
	default: // length, head
		return "cm"
	}
}

// serMeasurement converts one joined measurement_log+users row into the
// wire shape. GetMeasurement, ListMeasurements, ListMeasurementsPage and
// LastMeasurementOfType produce four names for this one shape; callers
// holding another of them convert (see convert.go).
func serMeasurement(row dbgen.GetMeasurementRow) gen.MeasurementLog {
	return gen.MeasurementLog{
		Id:            row.ID,
		BabyId:        row.BabyID,
		CaretakerId:   row.CaretakerID,
		CaretakerName: row.CaretakerName,
		Time:          row.Time.Time,
		Type:          gen.MeasurementLogType(row.Type),
		Value:         row.Value,
		Notes:         row.Notes,
	}
}

// ListMeasurements implements GET /api/measurements.
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
		out[i] = serMeasurement(dbgen.GetMeasurementRow(row))
	}
	return gen.ListMeasurements200JSONResponse(out), nil
}

// CreateMeasurement implements POST /api/measurements. {babyId, time,
// type, value, notes?} → 201 / 404 unknown baby. Free in Go (see
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
				Time:        ts(body.Time),
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
		return gen.CreateMeasurement404JSONResponse(unknownBabyErr()), nil
	}
	return gen.CreateMeasurement201JSONResponse(serMeasurement(row)), nil
}

// UpdateMeasurement implements PATCH /api/measurements/{id}. partial
// (nullable clears) → MeasurementLog / 404.
func (d Deps) UpdateMeasurement(ctx context.Context, req gen.UpdateMeasurementRequestObject) (gen.UpdateMeasurementResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	p, err := patchBody(ctx, "UpdateMeasurement")
	if err != nil {
		return nil, err
	}

	timeSet, timeVal := patchField[time.Time](p, "time")
	typeSet, typeVal := patchField[string](p, "type")
	valueSet, valueVal := patchField[float64](p, "value")
	notesSet, notesVal := patchField[string](p, "notes")
	if err := p.Err(); err != nil {
		return nil, err
	}

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetMeasurementRow, error) {
			return d.Q.GetMeasurement(ctx, dbgen.GetMeasurementParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateMeasurement(ctx, dbgen.UpdateMeasurementParams{
				FamilyID: fam.FamilyID,
				ID:       req.Id,
				TimeSet:  timeSet,
				TimeVal:  tsFrom(timeVal),
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
	return gen.UpdateMeasurement200JSONResponse(serMeasurement(row)), nil
}

// DeleteMeasurement implements DELETE /api/measurements/{id}.
// {ok:true} / 404.
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
