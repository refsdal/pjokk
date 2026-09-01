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

// This file ports apps/api/src/routes/play.ts's running-session lifecycle
// (list/create/active/stop/update/delete). Play sessions are structurally a
// sleep_log clone — read sleep.go first; this file only calls out where
// play's own shape diverges from it.
//
// # Divergence 1 (shared with sleep.go): "at most one running session per
// # baby" is DB-enforced
//
// 00001_init.sql's partial unique index "play_one_active_per_baby" ON
// play_log(baby_id) WHERE end_time IS NULL means a second INSERT (or an
// UPDATE that clears end_time back to NULL) for a baby that already has one
// fails with SQLSTATE 23505, not silently — exactly sleep.go's divergence
// 1. CreatePlay pre-checks with ActivePlay AND catches the 23505 the
// pre-check's own race can't close; UpdatePlay needs the same 23505 catch
// for exactly one case — clearing endTime, which reopens a session. Both
// turn a 23505 into 409 {"error":"Already active","code":"ALREADY_ACTIVE"}
// via alreadyActivePlay() — apps/api/src/routes/play.ts's own message,
// distinct from sleep's "Already sleeping".
//
// # Divergence 2 (shared with sleep.go): GET /api/play/active must answer
// # bare JSON `null`
//
// See sleep.go's doc comment, divergence 2, for the full explanation —
// getActivePlayNullResponse below is the same hand-written response type
// for GetActivePlay200JSONResponse's generated (non-pointer) alias.
//
// # Divergence 3: no billing gate
//
// apps/api/src/routes/play.ts soft-locks POST behind canUse(family,
// "play") (premium). CLAUDE.md's entitlement helper always returns true on
// this port (see other_logs.go's package doc comment, which removed the
// same gate for the six Phase 3 kinds) — play create is free here, so
// CreatePlay below has no 402 path at all.
//
// # Divergence 4: no "location"-equivalent field, but a required "type"
//
// play_log has no location column; it has a required, non-nullable "type"
// (tummy/walk/play) sleep_log has no equivalent of — the same shape
// feed_log's "type" already has (see feeds.go's UpdateFeed for the
// established pattern of a settable-but-not-clearable string enum in the
// PATCH tri-state).
func alreadyActivePlay() gen.Error {
	return gen.Error{Error: "Already active", Code: "ALREADY_ACTIVE"}
}

// getActivePlayNullResponse is GetActivePlay's 200 response when there is
// no running session — see this file's doc comment, divergence 2.
type getActivePlayNullResponse struct{}

func (getActivePlayNullResponse) VisitGetActivePlayResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, err := w.Write([]byte("null"))
	return err
}

// serPlayRow converts one joined play_log+users row into the wire shape.
// Three sqlc queries (GetPlay, ListPlays, ActivePlay) produce
// structurally-identical row types under different generated names, hence
// the thin per-type wrappers below rather than one function taking a row
// type directly — the same shape sleep.go's serSleepRow/serSleep/
// serSleepListRow/serActiveSleepRow quartet uses.
func serPlayRow(id, babyID, caretakerID, caretakerName, typ string, start, end pgtype.Timestamptz, notes *string) gen.PlayLog {
	return gen.PlayLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Notes:         notes,
		Type:          gen.PlayLogType(typ),
		StartTime:     start.Time,
		EndTime:       tsPtr(end),
	}
}

func serPlay(row dbgen.GetPlayRow) gen.PlayLog {
	return serPlayRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Type, row.StartTime, row.EndTime, row.Notes)
}

func serPlayListRow(row dbgen.ListPlaysRow) gen.PlayLog {
	return serPlayRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Type, row.StartTime, row.EndTime, row.Notes)
}

// serActivePlayRow backs both GetActivePlay (this file) and GetSummary's
// activePlay field (summary.go) — the same sharing sleep.go's
// serActiveSleepRow provides for activeSleep.
func serActivePlayRow(row dbgen.ActivePlayRow) gen.PlayLog {
	return serPlayRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Type, row.StartTime, row.EndTime, row.Notes)
}

// ListPlays implements GET /api/play. REF: "PlayLog[] newest first (by
// startTime)".
func (d Deps) ListPlays(ctx context.Context, req gen.ListPlaysRequestObject) (gen.ListPlaysResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	limit := int32(listFeedsDefaultLimit)
	if req.Params.Limit != nil {
		limit = int32(*req.Params.Limit)
	}

	rows, err := d.Q.ListPlays(ctx, dbgen.ListPlaysParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.PlayLog, len(rows))
	for i, row := range rows {
		out[i] = serPlayListRow(row)
	}
	return gen.ListPlays200JSONResponse(out), nil
}

// CreatePlay implements POST /api/play. REF: "{babyId, type, startTime,
// endTime?, notes?} → 201; 404 unknown baby; 409 ALREADY_ACTIVE when
// creating a running session (endTime absent) while one exists" — see this
// file's doc comment, divergence 1, for why both a pre-check AND a 23505
// catch are needed, and divergence 3 for why there is no 402 path.
func (d Deps) CreatePlay(ctx context.Context, req gen.CreatePlayRequestObject) (gen.CreatePlayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreatePlay")
	}
	body := req.Body

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: body.BabyId}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.CreatePlay404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	startingActive := body.EndTime == nil
	if startingActive {
		if _, err := d.Q.ActivePlay(ctx, dbgen.ActivePlayParams{FamilyID: fam.FamilyID, BabyID: &body.BabyId}); err == nil {
			return gen.CreatePlay409JSONResponse(alreadyActivePlay()), nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}

	var endTime pgtype.Timestamptz
	if body.EndTime != nil {
		endTime = pgtype.Timestamptz{Time: *body.EndTime, Valid: true}
	}

	id, err := d.Q.CreatePlay(ctx, dbgen.CreatePlayParams{
		FamilyID:    fam.FamilyID,
		BabyID:      body.BabyId,
		CaretakerID: fam.UserID,
		Type:        string(body.Type),
		StartTime:   pgtype.Timestamptz{Time: body.StartTime, Valid: true},
		EndTime:     endTime,
		Notes:       body.Notes,
	})
	if err != nil {
		// The partial unique index closes the race the pre-check above
		// can't: two requests can both pass ActivePlay's read before either
		// INSERTs.
		if startingActive && db.IsUniqueViolation(err) {
			return gen.CreatePlay409JSONResponse(alreadyActivePlay()), nil
		}
		return nil, err
	}

	created, err := d.Q.GetPlay(ctx, dbgen.GetPlayParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreatePlay201JSONResponse(serPlay(created)), nil
}

// GetActivePlay implements GET /api/play/active. REF: "PlayLog | null" —
// see this file's doc comment, divergence 2, for why the "no running
// session" branch returns a hand-written response type instead of the
// generated 200 one.
func (d Deps) GetActivePlay(ctx context.Context, req gen.GetActivePlayRequestObject) (gen.GetActivePlayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	row, err := d.Q.ActivePlay(ctx, dbgen.ActivePlayParams{FamilyID: fam.FamilyID, BabyID: req.Params.BabyId})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return getActivePlayNullResponse{}, nil
		}
		return nil, err
	}
	return gen.GetActivePlay200JSONResponse(serActivePlayRow(row)), nil
}

// StopPlay implements POST /api/play/{id}/stop. REF: "body optional
// {endTime?} (default now via Deps.Now) → PlayLog / 404". The end_time IS
// NULL guard in queries/play.sql's StopPlay makes a double-stop a 404 (zero
// rows affected) rather than silently overwriting the endTime a first stop
// already set — mirrors sleep.go's WakeSleep.
func (d Deps) StopPlay(ctx context.Context, req gen.StopPlayRequestObject) (gen.StopPlayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	endTime := d.Now()
	if req.Body != nil && req.Body.EndTime != nil {
		endTime = *req.Body.EndTime
	}

	n, err := d.Q.StopPlay(ctx, dbgen.StopPlayParams{
		FamilyID: fam.FamilyID,
		ID:       req.Id,
		EndTime:  pgtype.Timestamptz{Time: endTime, Valid: true},
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.StopPlay404JSONResponse{Error: "No such running session", Code: "NOT_FOUND"}, nil
	}

	updated, err := d.Q.GetPlay(ctx, dbgen.GetPlayParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.StopPlay200JSONResponse(serPlay(updated)), nil
}

// UpdatePlay implements PATCH /api/play/{id}. REF: "{type?, startTime?,
// endTime? (nullable clears→reopens), notes?(nullable)} → 200 / 404 / 409
// on reopen conflict". See feeds.go's package doc comment for the
// presence-detection pattern below, and this file's doc comment (divergence
// 1) for why only the endTime-cleared case needs a 23505 catch.
func (d Deps) UpdatePlay(ctx context.Context, req gen.UpdatePlayRequestObject) (gen.UpdatePlayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	existing, err := d.Q.GetPlay(ctx, dbgen.GetPlayParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdatePlay404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdatePlay")
	}

	typeSet, typeVal, err := patchField[string](fields, "type")
	if err != nil {
		return nil, err
	}
	startSet, startVal, err := patchField[time.Time](fields, "startTime")
	if err != nil {
		return nil, err
	}
	endSet, endVal, err := patchField[time.Time](fields, "endTime")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}

	if !typeSet && !startSet && !endSet && !notesSet {
		return gen.UpdatePlay200JSONResponse(serPlay(existing)), nil
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

	if _, err := d.Q.UpdatePlay(ctx, dbgen.UpdatePlayParams{
		FamilyID:     fam.FamilyID,
		ID:           req.Id,
		TypeSet:      typeSet,
		TypeVal:      typeVal,
		StartTimeSet: startSet,
		StartTimeVal: startParam,
		EndTimeSet:   endSet,
		EndTimeVal:   endParam,
		NotesSet:     notesSet,
		NotesVal:     notesVal,
	}); err != nil {
		if reopening && db.IsUniqueViolation(err) {
			return gen.UpdatePlay409JSONResponse(alreadyActivePlay()), nil
		}
		return nil, err
	}

	updated, err := d.Q.GetPlay(ctx, dbgen.GetPlayParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.UpdatePlay200JSONResponse(serPlay(updated)), nil
}

// DeletePlay implements DELETE /api/play/{id}. REF: "{ok:true} / 404".
func (d Deps) DeletePlay(ctx context.Context, req gen.DeletePlayRequestObject) (gen.DeletePlayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeletePlay(ctx, dbgen.DeletePlayParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeletePlay404JSONResponse(notFound()), nil
	}
	return gen.DeletePlay200JSONResponse{Ok: gen.OkOkTrue}, nil
}
