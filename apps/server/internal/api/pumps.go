package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "pumps" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — the shape closest to feeds.go (three clearable
// columns beyond notes: side, amountMl, durationMin). See other_logs.go's
// package doc comment for the shared createLog/updateLog/deleteLog engine
// and feeds.go's package doc comment for the PATCH tri-state pattern this
// file's UpdatePump reuses.

func pumpSidePtr(s *string) *gen.PumpLogSide {
	if s == nil {
		return nil
	}
	v := gen.PumpLogSide(*s)
	return &v
}

func serPump(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, side *string, amountMl, durationMin *int32, notes *string) gen.PumpLog {
	return gen.PumpLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Side:          pumpSidePtr(side),
		AmountMl:      amountMl,
		DurationMin:   durationMin,
		Notes:         notes,
	}
}

// ListPumps implements GET /api/pumps. REF: "PumpLog[] newest first".
func (d Deps) ListPumps(ctx context.Context, req gen.ListPumpsRequestObject) (gen.ListPumpsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListPumps(ctx, dbgen.ListPumpsParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.PumpLog, len(rows))
	for i, row := range rows {
		out[i] = serPump(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Side, row.AmountMl, row.DurationMin, row.Notes)
	}
	return gen.ListPumps200JSONResponse(out), nil
}

// CreatePump implements POST /api/pumps. REF: "{babyId, time, side?,
// amountMl?, durationMin?, notes?} → 201 / 404 unknown baby". Free in Go
// (see other_logs.go's doc comment).
func (d Deps) CreatePump(ctx context.Context, req gen.CreatePumpRequestObject) (gen.CreatePumpResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreatePump")
	}
	body := req.Body

	var side *string
	if body.Side != nil {
		v := string(*body.Side)
		side = &v
	}

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreatePump(ctx, dbgen.CreatePumpParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
				Side:        side,
				AmountMl:    body.AmountMl,
				DurationMin: body.DurationMin,
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetPumpRow, error) {
			return d.Q.GetPump(ctx, dbgen.GetPumpParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreatePump404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreatePump201JSONResponse(serPump(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Side, row.AmountMl, row.DurationMin, row.Notes)), nil
}

// UpdatePump implements PATCH /api/pumps/{id}. REF: "partial (nullable
// clears) → PumpLog / 404".
func (d Deps) UpdatePump(ctx context.Context, req gen.UpdatePumpRequestObject) (gen.UpdatePumpResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdatePump")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	sideSet, sideVal, err := patchField[string](fields, "side")
	if err != nil {
		return nil, err
	}
	amountSet, amountVal, err := patchField[int32](fields, "amountMl")
	if err != nil {
		return nil, err
	}
	durationSet, durationVal, err := patchField[int32](fields, "durationMin")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || sideSet || amountSet || durationSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetPumpRow, error) {
			return d.Q.GetPump(ctx, dbgen.GetPumpParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdatePump(ctx, dbgen.UpdatePumpParams{
				FamilyID:       fam.FamilyID,
				ID:             req.Id,
				TimeSet:        timeSet,
				TimeVal:        timeParam,
				SideSet:        sideSet,
				SideVal:        sideVal,
				AmountMlSet:    amountSet,
				AmountMlVal:    amountVal,
				DurationMinSet: durationSet,
				DurationMinVal: durationVal,
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
		return gen.UpdatePump404JSONResponse(notFound()), nil
	}
	return gen.UpdatePump200JSONResponse(serPump(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Side, row.AmountMl, row.DurationMin, row.Notes)), nil
}

// DeletePump implements DELETE /api/pumps/{id}. REF: "{ok:true} / 404".
func (d Deps) DeletePump(ctx context.Context, req gen.DeletePumpRequestObject) (gen.DeletePumpResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeletePump(ctx, dbgen.DeletePumpParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeletePump404JSONResponse(notFound()), nil
	}
	return gen.DeletePump200JSONResponse{Ok: gen.OkOkTrue}, nil
}
