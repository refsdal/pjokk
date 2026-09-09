package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// The family's medicine catalogue (issue #49): GET/POST/PATCH/DELETE
// /api/medicines. A bespoke family entity like contacts — no time, no
// caretaker. The DOSE log stays at /api/medicine (medicine.go); a dose may
// point at an entry through medicineId, and the entry carries lastDoseAt
// (per baby when the list is asked with ?babyId) so the sheet can say
// "next dose OK from HH:MM" without a second query. The app ships no
// intervals of its own: the number is the family's, shown back to them.

func serCatalogueMedicineRow(id, name string, defaultAmount *float64, unit *string, minInterval *int32, isSupplement bool, archivedAt, lastDose pgtype.Timestamptz) gen.MedicineCatalogueEntry {
	return gen.MedicineCatalogueEntry{
		Id:             id,
		Name:           name,
		DefaultAmount:  defaultAmount,
		Unit:           enumPtr[gen.MedicineCatalogueEntryUnit](unit),
		MinIntervalMin: minInterval,
		IsSupplement:   isSupplement,
		Archived:       archivedAt.Valid,
		LastDoseAt:     tsPtr(lastDose),
	}
}

func serCatalogueMedicine(r dbgen.GetCatalogueMedicineRow) gen.MedicineCatalogueEntry {
	return serCatalogueMedicineRow(r.ID, r.Name, r.DefaultAmount, r.Unit, r.MinIntervalMin, r.IsSupplement, r.ArchivedAt, r.LastDoseAt)
}

// ListMedicineCatalogue implements GET /api/medicines.
func (d Deps) ListMedicineCatalogue(ctx context.Context, req gen.ListMedicineCatalogueRequestObject) (gen.ListMedicineCatalogueResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListCatalogueMedicines(ctx, dbgen.ListCatalogueMedicinesParams{FamilyID: fam.FamilyID, BabyID: req.Params.BabyId})
	if err != nil {
		return nil, err
	}
	out := make([]gen.MedicineCatalogueEntry, len(rows))
	for i, r := range rows {
		out[i] = serCatalogueMedicineRow(r.ID, r.Name, r.DefaultAmount, r.Unit, r.MinIntervalMin, r.IsSupplement, r.ArchivedAt, r.LastDoseAt)
	}
	return gen.ListMedicineCatalogue200JSONResponse(out), nil
}

// CreateMedicineCatalogueEntry implements POST /api/medicines.
func (d Deps) CreateMedicineCatalogueEntry(ctx context.Context, req gen.CreateMedicineCatalogueEntryRequestObject) (gen.CreateMedicineCatalogueEntryResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateMedicineCatalogueEntry")
	}
	body := req.Body
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return gen.CreateMedicineCatalogueEntry400JSONResponse{Error: "A medicine needs a name", Code: "VALIDATION"}, nil
	}
	isSupplement := false
	if body.IsSupplement != nil {
		isSupplement = *body.IsSupplement
	}
	id, err := d.Q.CreateCatalogueMedicine(ctx, dbgen.CreateCatalogueMedicineParams{
		FamilyID:       fam.FamilyID,
		Name:           name,
		DefaultAmount:  body.DefaultAmount,
		Unit:           enumStr(body.Unit),
		MinIntervalMin: body.MinIntervalMin,
		IsSupplement:   isSupplement,
	})
	if err != nil {
		return nil, err
	}
	row, err := d.Q.GetCatalogueMedicine(ctx, dbgen.GetCatalogueMedicineParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateMedicineCatalogueEntry201JSONResponse(serCatalogueMedicine(row)), nil
}

// UpdateMedicineCatalogueEntry implements PATCH /api/medicines/{id} — the
// feeds.go tri-state: omitted leaves, null clears, a value sets. `archived`
// is a boolean on the wire and a timestamp in the row.
func (d Deps) UpdateMedicineCatalogueEntry(ctx context.Context, req gen.UpdateMedicineCatalogueEntryRequestObject) (gen.UpdateMedicineCatalogueEntryResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if _, err := d.Q.GetCatalogueMedicine(ctx, dbgen.GetCatalogueMedicineParams{FamilyID: fam.FamilyID, ID: req.Id}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateMedicineCatalogueEntry404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	p, err := patchBody(ctx, "UpdateMedicineCatalogueEntry")
	if err != nil {
		return nil, err
	}
	nameSet, nameVal := patchField[string](p, "name")
	if nameSet {
		if nameVal == nil || strings.TrimSpace(*nameVal) == "" {
			return gen.UpdateMedicineCatalogueEntry400JSONResponse{Error: "A medicine needs a name", Code: "VALIDATION"}, nil
		}
		v := strings.TrimSpace(*nameVal)
		nameVal = &v
	}
	amountSet, amountVal := patchField[float64](p, "defaultAmount")
	unitSet, unitVal := patchField[string](p, "unit")
	intervalSet, intervalVal := patchField[int32](p, "minIntervalMin")
	supplementSet, supplementVal := patchField[bool](p, "isSupplement")
	archivedSet, archivedVal := patchField[bool](p, "archived")
	if err := p.Err(); err != nil {
		return nil, err
	}
	var archivedAt pgtype.Timestamptz
	if archivedSet && archivedVal != nil && *archivedVal {
		archivedAt = ts(d.Now())
	}
	if nameSet || amountSet || unitSet || intervalSet || supplementSet || archivedSet {
		if _, err := d.Q.UpdateCatalogueMedicine(ctx, dbgen.UpdateCatalogueMedicineParams{
			FamilyID:          fam.FamilyID,
			ID:                req.Id,
			NameSet:           nameSet,
			NameVal:           nameVal,
			DefaultAmountSet:  amountSet,
			DefaultAmountVal:  amountVal,
			UnitSet:           unitSet,
			UnitVal:           unitVal,
			MinIntervalMinSet: intervalSet,
			MinIntervalMinVal: intervalVal,
			IsSupplementSet:   supplementSet,
			IsSupplementVal:   supplementVal,
			ArchivedSet:       archivedSet,
			ArchivedAtVal:     archivedAt,
		}); err != nil {
			return nil, err
		}
	}
	row, err := d.Q.GetCatalogueMedicine(ctx, dbgen.GetCatalogueMedicineParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.UpdateMedicineCatalogueEntry200JSONResponse(serCatalogueMedicine(row)), nil
}

// DeleteMedicineCatalogueEntry implements DELETE /api/medicines/{id}. The
// doses that pointed at it keep their name (ON DELETE SET NULL).
func (d Deps) DeleteMedicineCatalogueEntry(ctx context.Context, req gen.DeleteMedicineCatalogueEntryRequestObject) (gen.DeleteMedicineCatalogueEntryResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteCatalogueMedicine(ctx, dbgen.DeleteCatalogueMedicineParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteMedicineCatalogueEntry404JSONResponse(notFound()), nil
	}
	return gen.DeleteMedicineCatalogueEntry200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// catalogueMedicineBelongs is the dose log's check that a medicineId names
// one of the family's own entries; nil is always fine (a free-text dose).
func (d Deps) catalogueMedicineBelongs(ctx context.Context, familyID string, id *string) (bool, error) {
	if id == nil {
		return true, nil
	}
	_, err := d.Q.GetCatalogueMedicine(ctx, dbgen.GetCatalogueMedicineParams{FamilyID: familyID, ID: *id})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

var _ = time.Now
