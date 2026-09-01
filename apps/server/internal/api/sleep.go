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

// This file ports apps/api/src/routes/sleep.ts's active-session lifecycle
// (list/create/active/wake/update/delete — the summary route lives in
// summary.go). Read feeds.go first for the shared PATCH tri-state pattern;
// this file only calls out where sleep's own shape diverges from
// feeds.go/diapers.go.
//
// # Divergence 1: "at most one active session per baby" is DB-enforced
//
// 00001_init.sql's partial unique index "sleep_one_active_per_baby" ON
// sleep_log(baby_id) WHERE end_time IS NULL means a second INSERT (or an
// UPDATE that clears end_time back to NULL) for a baby that already has one
// fails with SQLSTATE 23505, not silently. CreateSleep pre-checks with
// ActiveSleep AND catches the 23505 the pre-check's own race can't close
// (two requests both passing the pre-check, then both inserting); UpdateSleep
// needs the same 23505 catch for exactly one case — clearing endTime, which
// reopens a session — because that's the only UpdateSleep write that can
// ever collide with the index. Both turn a 23505 into 409
// {"error":"Already sleeping","code":"ALREADY_ACTIVE"} via alreadyActive().
//
// # Divergence 2: GET /api/sleep/active must answer bare JSON `null`
//
// apps/api/src/routes/sleep.ts returns `c.json(row ? serSleep(row) : null)`
// — a literal `null` body, not `{}` or an omitted field. oapi-codegen turns
// a NULLABLE PROPERTY of an object into a Go pointer (see Summary's
// ActiveSleep/LastSleep, both *SleepLog), but a nullable schema used as an
// ENTIRE response body doesn't get the same treatment: the generated
// GetActiveSleep200JSONResponse is a plain (non-pointer) gen.SleepLog alias,
// so returning one for "no active session" would marshal a zero-valued
// SleepLog object, not null. getActiveSleepNullResponse below implements
// gen.GetActiveSleepResponseObject by hand to write the literal `null` body
// oapi-codegen's generated type cannot produce.
func alreadyActive() gen.Error {
	return gen.Error{Error: "Already sleeping", Code: "ALREADY_ACTIVE"}
}

// getActiveSleepNullResponse is GetActiveSleep's 200 response when there is
// no active session — see this file's doc comment, divergence 2.
type getActiveSleepNullResponse struct{}

func (getActiveSleepNullResponse) VisitGetActiveSleepResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, err := w.Write([]byte("null"))
	return err
}

// tsPtr converts a nullable Postgres timestamptz to a *time.Time: nil when
// SQL NULL (an active session's endTime), a pointer to the value otherwise.
func tsPtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

// serSleepRow converts one joined sleep_log+users row into the wire shape.
// Three sqlc queries (GetSleep, ListSleeps, ActiveSleep) produce
// structurally-identical row types under different generated names, hence
// the thin per-type wrappers below rather than one function taking a row
// type directly — the same shape feeds.go's serFeedRow/serFeed/
// serFeedListRow trio uses.
func serSleepRow(id, babyID, caretakerID, caretakerName string, start, end pgtype.Timestamptz, location, notes *string) gen.SleepLog {
	return gen.SleepLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Notes:         notes,
		StartTime:     start.Time,
		EndTime:       tsPtr(end),
		Location:      location,
	}
}

func serSleep(row dbgen.GetSleepRow) gen.SleepLog {
	return serSleepRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.StartTime, row.EndTime, row.Location, row.Notes)
}

func serSleepListRow(row dbgen.ListSleepsRow) gen.SleepLog {
	return serSleepRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.StartTime, row.EndTime, row.Location, row.Notes)
}

func serActiveSleepRow(row dbgen.ActiveSleepRow) gen.SleepLog {
	return serSleepRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.StartTime, row.EndTime, row.Location, row.Notes)
}

// ListSleeps implements GET /api/sleep. REF: "SleepLog[] newest first (by
// startTime)".
func (d Deps) ListSleeps(ctx context.Context, req gen.ListSleepsRequestObject) (gen.ListSleepsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	limit := int32(listFeedsDefaultLimit)
	if req.Params.Limit != nil {
		limit = int32(*req.Params.Limit)
	}

	rows, err := d.Q.ListSleeps(ctx, dbgen.ListSleepsParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.SleepLog, len(rows))
	for i, row := range rows {
		out[i] = serSleepListRow(row)
	}
	return gen.ListSleeps200JSONResponse(out), nil
}

// CreateSleep implements POST /api/sleep. REF: "{babyId, startTime, endTime?,
// location?, notes?} → 201; 404 unknown baby; 409 ALREADY_ACTIVE when
// creating an active session (endTime absent) while one exists" — see this
// file's doc comment, divergence 1, for why both a pre-check AND a 23505
// catch are needed.
func (d Deps) CreateSleep(ctx context.Context, req gen.CreateSleepRequestObject) (gen.CreateSleepResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateSleep")
	}
	body := req.Body

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: body.BabyId}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.CreateSleep404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	startingActive := body.EndTime == nil
	if startingActive {
		if _, err := d.Q.ActiveSleep(ctx, dbgen.ActiveSleepParams{FamilyID: fam.FamilyID, BabyID: &body.BabyId}); err == nil {
			return gen.CreateSleep409JSONResponse(alreadyActive()), nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	var endTime pgtype.Timestamptz
	if body.EndTime != nil {
		endTime = pgtype.Timestamptz{Time: *body.EndTime, Valid: true}
	}

	id, err := d.Q.CreateSleep(ctx, dbgen.CreateSleepParams{
		FamilyID:    fam.FamilyID,
		BabyID:      body.BabyId,
		CaretakerID: fam.UserID,
		StartTime:   pgtype.Timestamptz{Time: body.StartTime, Valid: true},
		EndTime:     endTime,
		Location:    body.Location,
		Notes:       body.Notes,
	})
	if err != nil {
		// The partial unique index closes the race the pre-check above
		// can't: two requests can both pass ActiveSleep's read before
		// either INSERTs.
		if startingActive && db.IsUniqueViolation(err) {
			return gen.CreateSleep409JSONResponse(alreadyActive()), nil
		}
		return nil, err
	}

	created, err := d.Q.GetSleep(ctx, dbgen.GetSleepParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateSleep201JSONResponse(serSleep(created)), nil
}

// GetActiveSleep implements GET /api/sleep/active. REF: "SleepLog | null" —
// see this file's doc comment, divergence 2, for why the "no active
// session" branch returns a hand-written response type instead of the
// generated 200 one.
func (d Deps) GetActiveSleep(ctx context.Context, req gen.GetActiveSleepRequestObject) (gen.GetActiveSleepResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	row, err := d.Q.ActiveSleep(ctx, dbgen.ActiveSleepParams{FamilyID: fam.FamilyID, BabyID: req.Params.BabyId})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return getActiveSleepNullResponse{}, nil
		}
		return nil, err
	}
	return gen.GetActiveSleep200JSONResponse(serActiveSleepRow(row)), nil
}

// WakeSleep implements POST /api/sleep/{id}/wake. REF: "body optional
// {endTime?} (default now via Deps.Now) → SleepLog / 404". The end_time IS
// NULL guard in queries/sleep.sql's WakeSleep makes a double-wake a 404
// (zero rows affected) rather than silently overwriting the endTime a first
// wake already set.
func (d Deps) WakeSleep(ctx context.Context, req gen.WakeSleepRequestObject) (gen.WakeSleepResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	endTime := d.Now()
	if req.Body != nil && req.Body.EndTime != nil {
		endTime = *req.Body.EndTime
	}

	n, err := d.Q.WakeSleep(ctx, dbgen.WakeSleepParams{
		FamilyID: fam.FamilyID,
		ID:       req.Id,
		EndTime:  pgtype.Timestamptz{Time: endTime, Valid: true},
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.WakeSleep404JSONResponse{Error: "No such active session", Code: "NOT_FOUND"}, nil
	}

	updated, err := d.Q.GetSleep(ctx, dbgen.GetSleepParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.WakeSleep200JSONResponse(serSleep(updated)), nil
}

// UpdateSleep implements PATCH /api/sleep/{id}. REF: "{startTime?, endTime?
// (nullable clears→reopens), location?(nullable), notes?(nullable)} → 200 /
// 404 / 409 on reopen conflict". See feeds.go's package doc comment for the
// presence-detection pattern below, and this file's doc comment (divergence
// 1) for why only the endTime-cleared case needs a 23505 catch.
func (d Deps) UpdateSleep(ctx context.Context, req gen.UpdateSleepRequestObject) (gen.UpdateSleepResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	existing, err := d.Q.GetSleep(ctx, dbgen.GetSleepParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateSleep404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateSleep")
	}

	startSet, startVal, err := patchField[time.Time](fields, "startTime")
	if err != nil {
		return nil, err
	}
	endSet, endVal, err := patchField[time.Time](fields, "endTime")
	if err != nil {
		return nil, err
	}
	locationSet, locationVal, err := patchField[string](fields, "location")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}

	if !startSet && !endSet && !locationSet && !notesSet {
		return gen.UpdateSleep200JSONResponse(serSleep(existing)), nil
	}

	var startParam pgtype.Timestamptz
	if startVal != nil {
		startParam = pgtype.Timestamptz{Time: *startVal, Valid: true}
	}
	var endParam pgtype.Timestamptz
	if endVal != nil {
		endParam = pgtype.Timestamptz{Time: *endVal, Valid: true}
	}
	// reopening is "endTime present and explicitly null" — the one write
	// this endpoint makes that can collide with the partial unique index
	// (see this file's doc comment, divergence 1).
	reopening := endSet && endVal == nil

	if _, err := d.Q.UpdateSleep(ctx, dbgen.UpdateSleepParams{
		FamilyID:     fam.FamilyID,
		ID:           req.Id,
		StartTimeSet: startSet,
		StartTimeVal: startParam,
		EndTimeSet:   endSet,
		EndTimeVal:   endParam,
		LocationSet:  locationSet,
		LocationVal:  locationVal,
		NotesSet:     notesSet,
		NotesVal:     notesVal,
	}); err != nil {
		if reopening && db.IsUniqueViolation(err) {
			return gen.UpdateSleep409JSONResponse(alreadyActive()), nil
		}
		return nil, err
	}

	updated, err := d.Q.GetSleep(ctx, dbgen.GetSleepParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.UpdateSleep200JSONResponse(serSleep(updated)), nil
}

// DeleteSleep implements DELETE /api/sleep/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteSleep(ctx context.Context, req gen.DeleteSleepRequestObject) (gen.DeleteSleepResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteSleep(ctx, dbgen.DeleteSleepParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteSleep404JSONResponse(notFound()), nil
	}
	return gen.DeleteSleep200JSONResponse{Ok: gen.OkOkTrue}, nil
}
