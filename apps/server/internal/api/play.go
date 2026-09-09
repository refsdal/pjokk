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

// serPlay converts one joined play_log+users row into the wire shape.
// GetPlay, ListPlays, ActivePlay and ListPlaysPage produce four names for
// this one shape; callers holding another of them convert (see convert.go).
// It backs GetActivePlay here and GetSummary's activePlay field alike.
func serPlay(row dbgen.GetPlayRow) gen.PlayLog {
	return gen.PlayLog{
		Id:            row.ID,
		BabyId:        row.BabyID,
		CaretakerId:   row.CaretakerID,
		CaretakerName: row.CaretakerName,
		Notes:         row.Notes,
		Type:          gen.PlayLogType(row.Type),
		StartTime:     row.StartTime.Time,
		EndTime:       tsPtr(row.EndTime),
	}
}

// ListPlays implements GET /api/play. REF: "PlayLog[] newest first (by
// startTime)".
func (d Deps) ListPlays(ctx context.Context, req gen.ListPlaysRequestObject) (gen.ListPlaysResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	rows, err := d.Q.ListPlays(ctx, dbgen.ListPlaysParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.PlayLog, len(rows))
	for i, row := range rows {
		out[i] = serPlay(dbgen.GetPlayRow(row))
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

	// Not createLog, for the reason CreateSleep gives: the ALREADY_ACTIVE
	// pre-check and the 23505 mapping do not fit a create closure that can
	// only answer (id, error). The baby check itself is still shared.
	known, err := babyExists(ctx, d, fam.FamilyID, body.BabyId)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.CreatePlay404JSONResponse(unknownBabyErr()), nil
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
		endTime = ts(*body.EndTime)
	}

	id, err := d.Q.CreatePlay(ctx, dbgen.CreatePlayParams{
		FamilyID:    fam.FamilyID,
		BabyID:      body.BabyId,
		CaretakerID: fam.UserID,
		Type:        string(body.Type),
		StartTime:   ts(body.StartTime),
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
	return gen.GetActivePlay200JSONResponse(serPlay(dbgen.GetPlayRow(row))), nil
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
		EndTime:  ts(endTime),
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

	p, err := patchBody(ctx, "UpdatePlay")
	if err != nil {
		return nil, err
	}

	typeSet, typeVal := patchField[string](p, "type")
	startSet, startVal := patchField[time.Time](p, "startTime")
	endSet, endVal := patchField[time.Time](p, "endTime")
	notesSet, notesVal := patchField[string](p, "notes")

	if err := p.Err(); err != nil {
		return nil, err
	}

	// reopening is "endTime present and explicitly null" — the one write
	// this endpoint makes that can collide with the partial unique index
	// (see this file's doc comment, divergence 1).
	reopening := endSet && endVal == nil

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetPlayRow, error) {
			return d.Q.GetPlay(ctx, dbgen.GetPlayParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdatePlay(ctx, dbgen.UpdatePlayParams{
				FamilyID:     fam.FamilyID,
				ID:           req.Id,
				TypeSet:      typeSet,
				TypeVal:      typeVal,
				StartTimeSet: startSet,
				StartTimeVal: tsFrom(startVal),
				EndTimeSet:   endSet,
				EndTimeVal:   tsFrom(endVal),
				NotesSet:     notesSet,
				NotesVal:     notesVal,
			})
			return err
		},
	)
	if err != nil {
		// updateLog hands back the update closure's error untouched, so the
		// index collision is still distinguishable here.
		if reopening && db.IsUniqueViolation(err) {
			return gen.UpdatePlay409JSONResponse(alreadyActivePlay()), nil
		}
		return nil, err
	}
	if !found {
		return gen.UpdatePlay404JSONResponse(notFound()), nil
	}
	return gen.UpdatePlay200JSONResponse(serPlay(row)), nil
}

// DeletePlay implements DELETE /api/play/{id}. REF: "{ok:true} / 404".
func (d Deps) DeletePlay(ctx context.Context, req gen.DeletePlayRequestObject) (gen.DeletePlayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeletePlay(ctx, dbgen.DeletePlayParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeletePlay404JSONResponse(notFound()), nil
	}
	return gen.DeletePlay200JSONResponse{Ok: gen.OkOkTrue}, nil
}
