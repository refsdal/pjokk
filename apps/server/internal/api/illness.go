package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Illness episodes (issue #107, spec
// docs/superpowers/specs/2026-09-17-illness-and-care-days-design.md). The
// lifecycle is daycare.go's, which is play.go's, which is sleep.go's: an
// open episode is end_time IS NULL, one per baby by 00023's partial unique
// index, created with a pre-check AND a 23505 catch, closed by an endpoint
// whose replay is a 404, reopened by PATCH {endTime: null}.
//
// # What this file deliberately does not do
//
// It holds no medical constant and draws no conclusion. clearHours is the
// family's own number for this episode; lastSymptomAt is what they told us.
// Neither is compared to anything here: the "48 h on Thursday 14:20" line
// is arithmetic the SPA does, and the fever threshold that moves the clock
// past a later temperature reading is the SPA's too (lib/measurements.ts),
// so there is exactly one place in the codebase that knows what a fever is.
func alreadyIll() gen.Error {
	return gen.Error{Error: "Already has an open illness", Code: "ALREADY_ACTIVE"}
}

type getActiveIllnessNullResponse struct{}

func (getActiveIllnessNullResponse) VisitGetActiveIllnessResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, err := w.Write([]byte("null"))
	return err
}

func serIllness(row dbgen.GetIllnessRow) gen.IllnessLog {
	symptoms := make([]gen.IllnessSymptom, len(row.Symptoms))
	for i, s := range row.Symptoms {
		symptoms[i] = gen.IllnessSymptom(s)
	}
	var clear *int
	if row.ClearHours != nil {
		v := int(*row.ClearHours)
		clear = &v
	}
	return gen.IllnessLog{
		Id:            row.ID,
		BabyId:        row.BabyID,
		CaretakerId:   row.CaretakerID,
		CaretakerName: row.CaretakerName,
		LoggedById:    row.LoggedByID,
		LoggedByName:  row.LoggedByName,
		StartTime:     row.StartTime.Time,
		EndTime:       tsPtr(row.EndTime),
		Symptoms:      symptoms,
		LastSymptomAt: tsPtr(row.LastSymptomAt),
		ClearHours:    clear,
		Notes:         row.Notes,
	}
}

func symptomStrings(in *[]gen.IllnessSymptom) []string {
	if in == nil {
		return []string{}
	}
	out := make([]string, len(*in))
	for i, s := range *in {
		out[i] = string(s)
	}
	return out
}

func int32Ptr(v *int) *int32 {
	if v == nil {
		return nil
	}
	x := int32(*v)
	return &x
}

// ListIllnesses implements GET /api/illness. Newest first (by startTime).
func (d Deps) ListIllnesses(ctx context.Context, req gen.ListIllnessesRequestObject) (gen.ListIllnessesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListIllnesses(ctx, dbgen.ListIllnessesParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.IllnessLog, len(rows))
	for i, row := range rows {
		out[i] = serIllness(dbgen.GetIllnessRow(row))
	}
	return gen.ListIllnesses200JSONResponse(out), nil
}

// CreateIllness implements POST /api/illness: open an episode, or with an
// endTime log one that is over.
func (d Deps) CreateIllness(ctx context.Context, req gen.CreateIllnessRequestObject) (gen.CreateIllnessResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateIllness")
	}
	body := req.Body

	caretaker, notMember, err := caretakerFor(ctx, d, fam, body.CaretakerId)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.CreateIllness403JSONResponse(notMemberErr()), nil
	}
	known, err := babyExists(ctx, d, fam.FamilyID, body.BabyId)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.CreateIllness404JSONResponse(unknownBabyErr()), nil
	}

	opening := body.EndTime == nil
	if opening {
		if _, err := d.Q.ActiveIllness(ctx, dbgen.ActiveIllnessParams{FamilyID: fam.FamilyID, BabyID: &body.BabyId}); err == nil {
			return gen.CreateIllness409JSONResponse(alreadyIll()), nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	var endTime pgtype.Timestamptz
	if body.EndTime != nil {
		endTime = ts(*body.EndTime)
	}
	id, err := d.Q.CreateIllness(ctx, dbgen.CreateIllnessParams{
		FamilyID:      fam.FamilyID,
		BabyID:        body.BabyId,
		CaretakerID:   caretaker,
		LoggedByID:    fam.UserID,
		StartTime:     ts(body.StartTime),
		EndTime:       endTime,
		Symptoms:      symptomStrings(body.Symptoms),
		LastSymptomAt: tsFrom(body.LastSymptomAt),
		ClearHours:    int32Ptr(body.ClearHours),
		Notes:         body.Notes,
	})
	if err != nil {
		if opening && db.IsUniqueViolation(err) {
			return gen.CreateIllness409JSONResponse(alreadyIll()), nil
		}
		return nil, err
	}
	created, err := d.Q.GetIllness(ctx, dbgen.GetIllnessParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateIllness201JSONResponse(serIllness(created)), nil
}

// GetActiveIllness implements GET /api/illness/active: the open episode or
// bare JSON null (sleep.go's doc comment says why the type is hand-written).
func (d Deps) GetActiveIllness(ctx context.Context, req gen.GetActiveIllnessRequestObject) (gen.GetActiveIllnessResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	row, err := d.Q.ActiveIllness(ctx, dbgen.ActiveIllnessParams{FamilyID: fam.FamilyID, BabyID: req.Params.BabyId})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return getActiveIllnessNullResponse{}, nil
		}
		return nil, err
	}
	return gen.GetActiveIllness200JSONResponse(serIllness(dbgen.GetIllnessRow(row))), nil
}

// RecoverIllness implements POST /api/illness/{id}/recover.
func (d Deps) RecoverIllness(ctx context.Context, req gen.RecoverIllnessRequestObject) (gen.RecoverIllnessResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	endTime := d.Now()
	if req.Body != nil && req.Body.EndTime != nil {
		endTime = *req.Body.EndTime
	}
	n, err := d.Q.RecoverIllness(ctx, dbgen.RecoverIllnessParams{FamilyID: fam.FamilyID, ID: req.Id, EndTime: ts(endTime)})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.RecoverIllness404JSONResponse{Error: "No such open episode", Code: "NOT_FOUND"}, nil
	}
	updated, err := d.Q.GetIllness(ctx, dbgen.GetIllnessParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.RecoverIllness200JSONResponse(serIllness(updated)), nil
}

// UpdateIllness implements PATCH /api/illness/{id}. See feeds.go for the
// omitted-versus-null pattern. `symptoms` is a whole-set replace: the sheet
// sends the chips as they stand.
func (d Deps) UpdateIllness(ctx context.Context, req gen.UpdateIllnessRequestObject) (gen.UpdateIllnessResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	p, err := patchBody(ctx, "UpdateIllness")
	if err != nil {
		return nil, err
	}
	startSet, startVal := patchField[time.Time](p, "startTime")
	endSet, endVal := patchField[time.Time](p, "endTime")
	symptomsSet, symptomsVal := patchField[[]string](p, "symptoms")
	lastSet, lastVal := patchField[time.Time](p, "lastSymptomAt")
	clearSet, clearVal := patchField[int32](p, "clearHours")
	notesSet, notesVal := patchField[string](p, "notes")
	caretakerSet, caretakerVal := patchField[string](p, "caretakerId")
	if err := p.Err(); err != nil {
		return nil, err
	}
	caretakerSet, caretakerVal, notMember, err := caretakerPatch(ctx, d, fam, caretakerSet, caretakerVal)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.UpdateIllness403JSONResponse(notMemberErr()), nil
	}
	// The column is NOT NULL: a null set of symptoms is the empty set.
	symptoms := []string{}
	if symptomsVal != nil {
		symptoms = *symptomsVal
	}

	reopening := endSet && endVal == nil
	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetIllnessRow, error) {
			return d.Q.GetIllness(ctx, dbgen.GetIllnessParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateIllness(ctx, dbgen.UpdateIllnessParams{
				FamilyID:         fam.FamilyID,
				ID:               req.Id,
				CaretakerIDSet:   caretakerSet,
				CaretakerIDVal:   caretakerVal,
				StartTimeSet:     startSet,
				StartTimeVal:     tsFrom(startVal),
				EndTimeSet:       endSet,
				EndTimeVal:       tsFrom(endVal),
				SymptomsSet:      symptomsSet,
				SymptomsVal:      symptoms,
				LastSymptomAtSet: lastSet,
				LastSymptomAtVal: tsFrom(lastVal),
				ClearHoursSet:    clearSet,
				ClearHoursVal:    clearVal,
				NotesSet:         notesSet,
				NotesVal:         notesVal,
			})
			return err
		},
	)
	if err != nil {
		if reopening && db.IsUniqueViolation(err) {
			return gen.UpdateIllness409JSONResponse(alreadyIll()), nil
		}
		return nil, err
	}
	if !found {
		return gen.UpdateIllness404JSONResponse(notFound()), nil
	}
	return gen.UpdateIllness200JSONResponse(serIllness(row)), nil
}

// DeleteIllness implements DELETE /api/illness/{id}.
func (d Deps) DeleteIllness(ctx context.Context, req gen.DeleteIllnessRequestObject) (gen.DeleteIllnessResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteIllness(ctx, dbgen.DeleteIllnessParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteIllness404JSONResponse(notFound()), nil
	}
	return gen.DeleteIllness200JSONResponse{Ok: gen.OkOkTrue}, nil
}
