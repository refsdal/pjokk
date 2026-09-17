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

// Days at barnehage (issue #105, spec
// docs/superpowers/specs/2026-09-17-daycare-session-design.md): a running
// session from drop-off to pick-up. It has no TypeScript ancestor — it is
// play.go's lifecycle, which is sleep.go's, so read those first; this file
// only calls out where a day at barnehage differs.
//
// # Difference 1: two people
//
// caretaker_id is who dropped off and follows the who-did-it rule
// (caretaker.go) like every log. pickup_caretaker_id is who picked up: set
// by PickupDaycare (the caller unless the body names someone), settable
// and clearable by PATCH, and only meaningful on a finished row. Both go
// through caretakerFor, so both answer 403 NOT_MEMBER for a stranger.
//
// # Difference 2: reopening forgets the pick-up
//
// PATCH {endTime: null} puts her back at barnehage. A running session has
// had no pick-up, so the same write clears pickup_caretaker_id rather than
// leave a name on a row that says nobody has come yet.
//
// # Shared with sleep.go and play.go
//
// One running session per baby is the database's rule (00020's partial
// unique index): CreateDaycare pre-checks AND catches the 23505 its own
// race cannot close, UpdateDaycare catches it for the reopen. GET
// /api/daycare/active answers bare JSON null through a hand-written
// response type, for the reason sleep.go's doc comment gives.
func alreadyAtDaycare() gen.Error {
	return gen.Error{Error: "Already at daycare", Code: "ALREADY_ACTIVE"}
}

type getActiveDaycareNullResponse struct{}

func (getActiveDaycareNullResponse) VisitGetActiveDaycareResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, err := w.Write([]byte("null"))
	return err
}

// serDaycare converts one joined daycare_log+users row into the wire shape.
// The list, active and timeline-page queries produce other names for this
// one shape; their callers convert.
func serDaycare(row dbgen.GetDaycareRow) gen.DaycareLog {
	return gen.DaycareLog{
		Id:                  row.ID,
		BabyId:              row.BabyID,
		CaretakerId:         row.CaretakerID,
		CaretakerName:       row.CaretakerName,
		LoggedById:          row.LoggedByID,
		LoggedByName:        row.LoggedByName,
		PickupCaretakerId:   row.PickupCaretakerID,
		PickupCaretakerName: row.PickupCaretakerName,
		Mood:                enumPtr[gen.DaycareLogMood](row.Mood),
		Notes:               row.Notes,
		StartTime:           row.StartTime.Time,
		EndTime:             tsPtr(row.EndTime),
	}
}

// ListDaycares implements GET /api/daycare. Newest first (by startTime).
func (d Deps) ListDaycares(ctx context.Context, req gen.ListDaycaresRequestObject) (gen.ListDaycaresResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	rows, err := d.Q.ListDaycares(ctx, dbgen.ListDaycaresParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.DaycareLog, len(rows))
	for i, row := range rows {
		out[i] = serDaycare(dbgen.GetDaycareRow(row))
	}
	return gen.ListDaycares200JSONResponse(out), nil
}

// CreateDaycare implements POST /api/daycare: the drop-off, or a finished
// day logged after the fact. {babyId, startTime, endTime?, caretakerId?,
// pickupCaretakerId?, notes?} → 201; 403 NOT_MEMBER; 404 unknown baby; 409
// ALREADY_ACTIVE when starting a running session while one exists.
func (d Deps) CreateDaycare(ctx context.Context, req gen.CreateDaycareRequestObject) (gen.CreateDaycareResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateDaycare")
	}
	body := req.Body

	caretaker, notMember, err := caretakerFor(ctx, d, fam, body.CaretakerId)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.CreateDaycare403JSONResponse(notMemberErr()), nil
	}

	startingActive := body.EndTime == nil

	// The pick-up person belongs to a finished day only (this file's doc
	// comment, difference 1); on a drop-off the field is ignored rather
	// than refused, so a client that always sends it is not punished.
	var pickup *string
	if !startingActive && body.PickupCaretakerId != nil {
		id, notMember, err := caretakerFor(ctx, d, fam, body.PickupCaretakerId)
		if err != nil {
			return nil, err
		}
		if notMember {
			return gen.CreateDaycare403JSONResponse(notMemberErr()), nil
		}
		pickup = &id
	}

	known, err := babyExists(ctx, d, fam.FamilyID, body.BabyId)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.CreateDaycare404JSONResponse(unknownBabyErr()), nil
	}

	if startingActive {
		if _, err := d.Q.ActiveDaycare(ctx, dbgen.ActiveDaycareParams{FamilyID: fam.FamilyID, BabyID: &body.BabyId}); err == nil {
			return gen.CreateDaycare409JSONResponse(alreadyAtDaycare()), nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	var endTime pgtype.Timestamptz
	if body.EndTime != nil {
		endTime = ts(*body.EndTime)
	}

	id, err := d.Q.CreateDaycare(ctx, dbgen.CreateDaycareParams{
		FamilyID:          fam.FamilyID,
		BabyID:            body.BabyId,
		CaretakerID:       caretaker,
		LoggedByID:        fam.UserID,
		PickupCaretakerID: pickup,
		StartTime:         ts(body.StartTime),
		EndTime:           endTime,
		Notes:             body.Notes,
	})
	if err != nil {
		// The partial unique index closes the race the pre-check cannot.
		if startingActive && db.IsUniqueViolation(err) {
			return gen.CreateDaycare409JSONResponse(alreadyAtDaycare()), nil
		}
		return nil, err
	}

	created, err := d.Q.GetDaycare(ctx, dbgen.GetDaycareParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateDaycare201JSONResponse(serDaycare(created)), nil
}

// GetActiveDaycare implements GET /api/daycare/active: the running session
// or null.
func (d Deps) GetActiveDaycare(ctx context.Context, req gen.GetActiveDaycareRequestObject) (gen.GetActiveDaycareResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	row, err := d.Q.ActiveDaycare(ctx, dbgen.ActiveDaycareParams{FamilyID: fam.FamilyID, BabyID: req.Params.BabyId})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return getActiveDaycareNullResponse{}, nil
		}
		return nil, err
	}
	return gen.GetActiveDaycare200JSONResponse(serDaycare(dbgen.GetDaycareRow(row))), nil
}

// PickupDaycare implements POST /api/daycare/{id}/pickup. Body optional
// {endTime?, caretakerId?}: now (Deps.Now) and the caller by default. The
// end_time IS NULL guard in the query makes a second pick-up a 404 rather
// than a rewrite of the first.
func (d Deps) PickupDaycare(ctx context.Context, req gen.PickupDaycareRequestObject) (gen.PickupDaycareResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	endTime := d.Now()
	var wanted *string
	if req.Body != nil {
		if req.Body.EndTime != nil {
			endTime = *req.Body.EndTime
		}
		wanted = req.Body.CaretakerId
	}
	pickup, notMember, err := caretakerFor(ctx, d, fam, wanted)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.PickupDaycare403JSONResponse(notMemberErr()), nil
	}

	n, err := d.Q.PickupDaycare(ctx, dbgen.PickupDaycareParams{
		FamilyID:          fam.FamilyID,
		ID:                req.Id,
		EndTime:           ts(endTime),
		PickupCaretakerID: &pickup,
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.PickupDaycare404JSONResponse{Error: "No such running session", Code: "NOT_FOUND"}, nil
	}

	updated, err := d.Q.GetDaycare(ctx, dbgen.GetDaycareParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.PickupDaycare200JSONResponse(serDaycare(updated)), nil
}

// UpdateDaycare implements PATCH /api/daycare/{id}. See feeds.go for the
// omitted-versus-null pattern, and this file's doc comment for the two
// rules of its own: the pick-up person is nullable, and a reopen clears it.
func (d Deps) UpdateDaycare(ctx context.Context, req gen.UpdateDaycareRequestObject) (gen.UpdateDaycareResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	p, err := patchBody(ctx, "UpdateDaycare")
	if err != nil {
		return nil, err
	}

	startSet, startVal := patchField[time.Time](p, "startTime")
	endSet, endVal := patchField[time.Time](p, "endTime")
	notesSet, notesVal := patchField[string](p, "notes")
	caretakerSet, caretakerVal := patchField[string](p, "caretakerId")
	pickupSet, pickupVal := patchField[string](p, "pickupCaretakerId")

	if err := p.Err(); err != nil {
		return nil, err
	}
	caretakerSet, caretakerVal, notMember, err := caretakerPatch(ctx, d, fam, caretakerSet, caretakerVal)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.UpdateDaycare403JSONResponse(notMemberErr()), nil
	}
	// Unlike caretakerId, null is a real value here ("not recorded"), so
	// only a named person is checked; set-with-null passes through.
	if pickupSet && pickupVal != nil {
		id, notMember, err := caretakerFor(ctx, d, fam, pickupVal)
		if err != nil {
			return nil, err
		}
		if notMember {
			return gen.UpdateDaycare403JSONResponse(notMemberErr()), nil
		}
		pickupVal = &id
	}

	reopening := endSet && endVal == nil
	if reopening {
		pickupSet, pickupVal = true, nil
	}

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetDaycareRow, error) {
			return d.Q.GetDaycare(ctx, dbgen.GetDaycareParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateDaycare(ctx, dbgen.UpdateDaycareParams{
				FamilyID:             fam.FamilyID,
				ID:                   req.Id,
				CaretakerIDSet:       caretakerSet,
				CaretakerIDVal:       caretakerVal,
				PickupCaretakerIDSet: pickupSet,
				PickupCaretakerIDVal: pickupVal,
				StartTimeSet:         startSet,
				StartTimeVal:         tsFrom(startVal),
				EndTimeSet:           endSet,
				EndTimeVal:           tsFrom(endVal),
				NotesSet:             notesSet,
				NotesVal:             notesVal,
			})
			return err
		},
	)
	if err != nil {
		if reopening && db.IsUniqueViolation(err) {
			return gen.UpdateDaycare409JSONResponse(alreadyAtDaycare()), nil
		}
		return nil, err
	}
	if !found {
		return gen.UpdateDaycare404JSONResponse(notFound()), nil
	}
	return gen.UpdateDaycare200JSONResponse(serDaycare(row)), nil
}

// DeleteDaycare implements DELETE /api/daycare/{id}.
func (d Deps) DeleteDaycare(ctx context.Context, req gen.DeleteDaycareRequestObject) (gen.DeleteDaycareResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteDaycare(ctx, dbgen.DeleteDaycareParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteDaycare404JSONResponse(notFound()), nil
	}
	return gen.DeleteDaycare200JSONResponse{Ok: gen.OkOkTrue}, nil
}
