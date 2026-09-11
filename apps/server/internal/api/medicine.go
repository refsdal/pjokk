package api

import (
	"context"
	"time"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "medicine" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — the one Phase 3 kind that was NEVER plan-gated
// (medicine: false in the TS route table). See other_logs.go's package doc
// comment for the shared createLog/updateLog/deleteLog engine this and every
// other Phase 3 kind's file instantiates, and feeds.go's package doc comment
// for the PATCH tri-state (patchBody/patchField) pattern UpdateMedicine
// reuses.

func medicineUnitPtr(s *string) *gen.MedicineLogUnit {
	if s == nil {
		return nil
	}
	v := gen.MedicineLogUnit(*s)
	return &v
}

// serMedicine converts one joined medicine_log+users row into the wire
// shape. See convert.go on converting between the per-query row types.
func serMedicine(row dbgen.GetMedicineRow) gen.MedicineLog {
	return gen.MedicineLog{
		Id:            row.ID,
		BabyId:        row.BabyID,
		CaretakerId:   row.CaretakerID,
		CaretakerName: row.CaretakerName,
		Time:          row.Time.Time,
		Name:          row.Name,
		Amount:        row.Amount,
		Unit:          medicineUnitPtr(row.Unit),
		MedicineId:    row.MedicineID,
		Notes:         row.Notes,
	}
}

// ListMedicine implements GET /api/medicine.
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
		out[i] = serMedicine(dbgen.GetMedicineRow(row))
	}
	return gen.ListMedicine200JSONResponse(out), nil
}

// CreateMedicine implements POST /api/medicine. {babyId, time, name,
// amount?, unit?, notes?} → 201 / 404 unknown baby.
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
	// A dose may point at one of the family's catalogue entries (issue #49).
	if ok, err := d.catalogueMedicineBelongs(ctx, fam.FamilyID, body.MedicineId); err != nil {
		return nil, err
	} else if !ok {
		return gen.CreateMedicine404JSONResponse{Error: "Unknown medicine", Code: "NOT_FOUND"}, nil
	}

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateMedicine(ctx, dbgen.CreateMedicineParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        ts(body.Time),
				Name:        body.Name,
				Amount:      body.Amount,
				Unit:        unit,
				MedicineID:  body.MedicineId,
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
		return gen.CreateMedicine404JSONResponse(unknownBabyErr()), nil
	}
	return gen.CreateMedicine201JSONResponse(serMedicine(row)), nil
}

// UpdateMedicine implements PATCH /api/medicine/{id}. partial
// (nullable clears) → MedicineLog / 404. `name`/`time` are settable but not
// nullable (patchField still detects their presence; they are never sent as
// a clearing null by the spec's schema — see UpdateMedicine's OpenAPI
// description).
func (d Deps) UpdateMedicine(ctx context.Context, req gen.UpdateMedicineRequestObject) (gen.UpdateMedicineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	p, err := patchBody(ctx, "UpdateMedicine")
	if err != nil {
		return nil, err
	}

	timeSet, timeVal := patchField[time.Time](p, "time")
	nameSet, nameVal := patchField[string](p, "name")
	amountSet, amountVal := patchField[float64](p, "amount")
	unitSet, unitVal := patchField[string](p, "unit")
	medicineSet, medicineVal := patchField[string](p, "medicineId")
	if medicineSet {
		if ok, err := d.catalogueMedicineBelongs(ctx, fam.FamilyID, medicineVal); err != nil {
			return nil, err
		} else if !ok {
			return gen.UpdateMedicine404JSONResponse{Error: "Unknown medicine", Code: "NOT_FOUND"}, nil
		}
	}
	notesSet, notesVal := patchField[string](p, "notes")
	if err := p.Err(); err != nil {
		return nil, err
	}

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetMedicineRow, error) {
			return d.Q.GetMedicine(ctx, dbgen.GetMedicineParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateMedicine(ctx, dbgen.UpdateMedicineParams{
				FamilyID:      fam.FamilyID,
				ID:            req.Id,
				TimeSet:       timeSet,
				TimeVal:       tsFrom(timeVal),
				NameSet:       nameSet,
				NameVal:       nameVal,
				AmountSet:     amountSet,
				AmountVal:     amountVal,
				UnitSet:       unitSet,
				UnitVal:       unitVal,
				MedicineIDSet: medicineSet,
				MedicineIDVal: medicineVal,
				NotesSet:      notesSet,
				NotesVal:      notesVal,
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
	return gen.UpdateMedicine200JSONResponse(serMedicine(row)), nil
}

// DeleteMedicine implements DELETE /api/medicine/{id}.
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
