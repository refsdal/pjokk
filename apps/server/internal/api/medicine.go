package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "medicine" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — the one Phase 3 kind that was NEVER plan-gated
// (medicine: false in the TS route table). See other_logs.go's package doc
// comment for the shared createLog/updateLog/deleteLog engine this and every
// other Phase 3 kind's file instantiates, and feeds.go's package doc comment
// for the PATCH tri-state (patchField/rawBodyFields) pattern UpdateMedicine
// reuses.

func medicineUnitPtr(s *string) *gen.MedicineLogUnit {
	if s == nil {
		return nil
	}
	v := gen.MedicineLogUnit(*s)
	return &v
}

func serMedicine(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, name string, amount *float64, unit *string, notes *string) gen.MedicineLog {
	return gen.MedicineLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Name:          name,
		Amount:        amount,
		Unit:          medicineUnitPtr(unit),
		Notes:         notes,
	}
}

// ListMedicine implements GET /api/medicine. REF: "MedicineLog[] newest first".
func (d Deps) ListMedicine(ctx context.Context, req gen.ListMedicineRequestObject) (gen.ListMedicineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListMedicine(ctx, dbgen.ListMedicineParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.MedicineLog, len(rows))
	for i, row := range rows {
		out[i] = serMedicine(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Name, row.Amount, row.Unit, row.Notes)
	}
	return gen.ListMedicine200JSONResponse(out), nil
}

// CreateMedicine implements POST /api/medicine. REF: "{babyId, time, name,
// amount?, unit?, notes?} → 201 / 404 unknown baby".
func (d Deps) CreateMedicine(ctx context.Context, req gen.CreateMedicineRequestObject) (gen.CreateMedicineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateMedicine")
	}
	body := req.Body

	var unit *string
	if body.Unit != nil {
		v := string(*body.Unit)
		unit = &v
	}

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateMedicine(ctx, dbgen.CreateMedicineParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
				Name:        body.Name,
				Amount:      body.Amount,
				Unit:        unit,
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetMedicineRow, error) {
			return d.Q.GetMedicine(ctx, dbgen.GetMedicineParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateMedicine404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreateMedicine201JSONResponse(serMedicine(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Name, row.Amount, row.Unit, row.Notes)), nil
}

// UpdateMedicine implements PATCH /api/medicine/{id}. REF: "partial
// (nullable clears) → MedicineLog / 404". `name`/`time` are settable but not
// nullable (patchField still detects their presence; they are never sent as
// a clearing null by the spec's schema — see UpdateMedicine's OpenAPI
// description).
func (d Deps) UpdateMedicine(ctx context.Context, req gen.UpdateMedicineRequestObject) (gen.UpdateMedicineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateMedicine")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	nameSet, nameVal, err := patchField[string](fields, "name")
	if err != nil {
		return nil, err
	}
	amountSet, amountVal, err := patchField[float64](fields, "amount")
	if err != nil {
		return nil, err
	}
	unitSet, unitVal, err := patchField[string](fields, "unit")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || nameSet || amountSet || unitSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetMedicineRow, error) {
			return d.Q.GetMedicine(ctx, dbgen.GetMedicineParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdateMedicine(ctx, dbgen.UpdateMedicineParams{
				FamilyID:  fam.FamilyID,
				ID:        req.Id,
				TimeSet:   timeSet,
				TimeVal:   timeParam,
				NameSet:   nameSet,
				NameVal:   nameVal,
				AmountSet: amountSet,
				AmountVal: amountVal,
				UnitSet:   unitSet,
				UnitVal:   unitVal,
				NotesSet:  notesSet,
				NotesVal:  notesVal,
			})
			return err
		},
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return gen.UpdateMedicine404JSONResponse(notFound()), nil
	}
	return gen.UpdateMedicine200JSONResponse(serMedicine(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Name, row.Amount, row.Unit, row.Notes)), nil
}

// DeleteMedicine implements DELETE /api/medicine/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteMedicine(ctx context.Context, req gen.DeleteMedicineRequestObject) (gen.DeleteMedicineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteMedicine(ctx, dbgen.DeleteMedicineParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteMedicine404JSONResponse(notFound()), nil
	}
	return gen.DeleteMedicine200JSONResponse{Ok: gen.OkOkTrue}, nil
}
