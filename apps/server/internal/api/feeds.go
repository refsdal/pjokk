package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/feeds.ts (REF §A1's feeds.ts route
// table): GET/POST /api/feeds, PATCH/DELETE /api/feeds/{id}. diapers.go is
// the identical skeleton one table over — read this file first, then that
// one's shorter comments.
//
// # The PATCH tri-state pattern (established here; reuse for every future
// # log-route PATCH — sleep, other-logs, play, …)
//
// UpdateFeedSchema (apps/api's zod predecessor) lets a client CLEAR a
// nullable field by sending it as JSON `null`, while OMITTING the field
// leaves the column untouched — three states (set, clear, leave) packed
// into two JSON possibilities (key present with a value, key present as
// null) plus one absence (key missing).
//
// The generated strict-server request type cannot represent this: Go's
// encoding/json collapses "key omitted" and "key sent as null" to the same
// nil pointer, so a struct-typed Body can only ever mean "set" or "leave",
// never "clear". babies.go's UpdateBaby gets away with that, because its one
// nullable field (`sex`) is cosmetic and never cleared in practice;
// amountMl/side/durationMin/leftMin/rightMin/notes are not (see
// TestUpdateFeedPatchClearsAmountMl in feeds_test.go), which is why the
// machinery below exists.
//
// The fix (patch.go): intercept the RAW request body before the strict
// handler's own json.Decode consumes it, and decode it ourselves into
// map[string]json.RawMessage — a Go map already distinguishes all three
// states for free. api.go's withRawBody middleware (wired into
// NewHandler's Middlewares, ahead of both spec validation and the strict
// decode) reads r.Body once, stashes the bytes in the request context, and
// replaces r.Body with a fresh reader over the same bytes so every
// downstream layer still sees a normal, once-only-readable body —
// including kin-openapi's spec validation, which still runs against
// UpdateFeed's nullable-typed schema and rejects a malformed or
// out-of-range body before this handler ever sees it. patch.go's
// patchBody collects that map into a patchSet, and patchField[T] turns one
// lookup on it into (set bool, value *T) for a single field — with the
// decode error latched on the set rather than returned per field, so a
// handler reads eleven fields in eleven lines and checks p.Err() once.
// p.Any() is then the empty-patch test, which cannot fall out of step with
// the fields above it the way a hand-written `!aSet && !bSet && …` chain
// could.
//
// Considered and rejected:
//   - Registering PATCH as a non-strict custom mux handler outside the
//     generated strict-server machinery: loses the generated request-type
//     documentation in the OpenAPI spec AND would need its own auth-tier
//     wiring, duplicating authChain/operationAuthTiers instead of reusing
//     them.
//   - A free-form `additionalProperties` body schema (no fixed
//     properties): loses per-field OpenAPI documentation and validation —
//     bounds like amountMl's 0..1000 would no longer be spec-enforced, and
//     UpdateFeed's schema would say nothing about its own shape.
//
// The chosen approach keeps spec validation, route registration, and
// assertOperationAuthCoverage exactly as every other operation uses them;
// only the body is read twice (once by withRawBody into the map this file
// uses, once by the strict handler's own decode into a typed Body this file
// deliberately ignores for PATCH — see UpdateFeed below).
//
// Building the UPDATE itself: rather than one sqlc query per possible
// combination of set/cleared columns, queries/feeds.sql's UpdateFeed takes
// one (`<column>_set` bool, `<column>_val` nullable) PAIR per clearable
// column and applies each with `SET col = CASE WHEN $set THEN $val ELSE col
// END` — untouched columns fall through to their own current value in the
// SAME statement that sets touched ones, a present-but-null pair writes SQL
// NULL (clear), and a present-with-value pair writes that value (set). A
// genuinely empty patch (no keys present at all) skips the UPDATE entirely
// and just re-reads the row, matching apps/api/src/db/scoped.ts's
// compactPatch no-op and babies.go's UpdateBaby.

// serFeed converts one joined feed_log+users row into the wire shape. Two
// sqlc queries (GetFeed, ListFeeds) produce structurally-identical row
// types under different generated names, hence the two thin wrappers below
// rather than one function taking a row type directly.
func serFeedRow(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, typ string, amountMl *int32, side *string, durationMin, leftMin, rightMin *int32, contents, food *string, reaction *bool, notes *string) gen.FeedLog {
	return gen.FeedLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Notes:         notes,
		Time:          t.Time,
		Type:          gen.FeedLogType(typ),
		AmountMl:      amountMl,
		Side:          enumPtr[gen.FeedLogSide](side),
		DurationMin:   durationMin,
		LeftMin:       leftMin,
		RightMin:      rightMin,
		Contents:      enumPtr[gen.FeedLogContents](contents),
		Food:          food,
		Reaction:      reaction,
	}
}

func serFeed(row dbgen.GetFeedRow) gen.FeedLog {
	return serFeedRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type,
		row.AmountMl, row.Side, row.DurationMin, row.LeftMin, row.RightMin, row.Contents, row.Food, row.Reaction, row.Notes)
}

func serFeedListRow(row dbgen.ListFeedsRow) gen.FeedLog {
	return serFeedRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type,
		row.AmountMl, row.Side, row.DurationMin, row.LeftMin, row.RightMin, row.Contents, row.Food, row.Reaction, row.Notes)
}

// ListFeeds implements GET /api/feeds. REF: "FeedLog[] newest first".
func (d Deps) ListFeeds(ctx context.Context, req gen.ListFeedsRequestObject) (gen.ListFeedsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	rows, err := d.Q.ListFeeds(ctx, dbgen.ListFeedsParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.FeedLog, len(rows))
	for i, row := range rows {
		out[i] = serFeedListRow(row)
	}
	return gen.ListFeeds200JSONResponse(out), nil
}

// CreateFeed implements POST /api/feeds. REF: "{babyId, time, type,
// amountMl?, side?, durationMin?, leftMin?, rightMin?, notes?} → 201 /
// 404 unknown baby".
func (d Deps) CreateFeed(ctx context.Context, req gen.CreateFeedRequestObject) (gen.CreateFeedResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateFeed")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateFeed(ctx, dbgen.CreateFeedParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        ts(body.Time),
				Type:        string(body.Type),
				AmountMl:    body.AmountMl,
				Side:        enumStr(body.Side),
				DurationMin: body.DurationMin,
				LeftMin:     body.LeftMin,
				RightMin:    body.RightMin,
				Contents:    enumStr(body.Contents),
				Food:        body.Food,
				Reaction:    body.Reaction,
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetFeedRow, error) {
			return d.Q.GetFeed(ctx, dbgen.GetFeedParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateFeed404JSONResponse(unknownBabyErr()), nil
	}
	return gen.CreateFeed201JSONResponse(serFeed(row)), nil
}

// UpdateFeed implements PATCH /api/feeds/{id}. REF: "partial (nullable
// clears) → FeedLog / 404". See this file's package doc comment for the
// presence-detection pattern below — req.Body (the generated strict type)
// is deliberately UNUSED here; patchBody/patchField read the same
// request body a second time, from the copy withRawBody stashed in ctx,
// because only that raw form can tell "omitted" from "explicit null" apart.
func (d Deps) UpdateFeed(ctx context.Context, req gen.UpdateFeedRequestObject) (gen.UpdateFeedResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	p, err := patchBody(ctx, "UpdateFeed")
	if err != nil {
		return nil, err
	}

	timeSet, timeVal := patchField[time.Time](p, "time")
	typeSet, typeVal := patchField[string](p, "type")
	amountSet, amountVal := patchField[int32](p, "amountMl")
	sideSet, sideVal := patchField[string](p, "side")
	durationSet, durationVal := patchField[int32](p, "durationMin")
	leftSet, leftVal := patchField[int32](p, "leftMin")
	rightSet, rightVal := patchField[int32](p, "rightMin")
	contentsSet, contentsVal := patchField[string](p, "contents")
	foodSet, foodVal := patchField[string](p, "food")
	reactionSet, reactionVal := patchField[bool](p, "reaction")
	notesSet, notesVal := patchField[string](p, "notes")

	if err := p.Err(); err != nil {
		return nil, err
	}

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetFeedRow, error) {
			return d.Q.GetFeed(ctx, dbgen.GetFeedParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateFeed(ctx, dbgen.UpdateFeedParams{
				FamilyID:       fam.FamilyID,
				ID:             req.Id,
				TimeSet:        timeSet,
				TimeVal:        tsFrom(timeVal),
				TypeSet:        typeSet,
				TypeVal:        typeVal,
				AmountMlSet:    amountSet,
				AmountMlVal:    amountVal,
				SideSet:        sideSet,
				SideVal:        sideVal,
				DurationMinSet: durationSet,
				DurationMinVal: durationVal,
				LeftMinSet:     leftSet,
				LeftMinVal:     leftVal,
				RightMinSet:    rightSet,
				RightMinVal:    rightVal,
				ContentsSet:    contentsSet,
				ContentsVal:    contentsVal,
				FoodSet:        foodSet,
				FoodVal:        foodVal,
				ReactionSet:    reactionSet,
				ReactionVal:    reactionVal,
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
		return gen.UpdateFeed404JSONResponse(notFound()), nil
	}
	return gen.UpdateFeed200JSONResponse(serFeed(row)), nil
}

// DeleteFeed implements DELETE /api/feeds/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteFeed(ctx context.Context, req gen.DeleteFeedRequestObject) (gen.DeleteFeedResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteFeed(ctx, dbgen.DeleteFeedParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteFeed404JSONResponse(notFound()), nil
	}
	return gen.DeleteFeed200JSONResponse{Ok: gen.OkOkTrue}, nil
}
