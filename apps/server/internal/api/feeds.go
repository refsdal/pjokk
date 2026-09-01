package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
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
// never "clear". This is exactly the babies.go UpdateBaby `sex` field
// simplification Task 9 documented and deliberately left unsolved — Task 10
// is the task that has to actually solve it, because amountMl/side/
// durationMin/leftMin/rightMin/notes are real, tested, higher-stakes
// clearable fields (see TestUpdateFeedPatchClearsAmountMl in feeds_test.go),
// unlike babies' cosmetic, never-cleared `sex`.
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
// patchField[T] turns one map lookup into (present bool, value *T, err
// error) for a single field.
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
func serFeedRow(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, typ string, amountMl *int32, side *string, durationMin, leftMin, rightMin *int32, notes *string) gen.FeedLog {
	return gen.FeedLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Notes:         notes,
		Time:          t.Time,
		Type:          gen.FeedLogType(typ),
		AmountMl:      amountMl,
		Side:          feedLogSidePtr(side),
		DurationMin:   durationMin,
		LeftMin:       leftMin,
		RightMin:      rightMin,
	}
}

func serFeed(row dbgen.GetFeedRow) gen.FeedLog {
	return serFeedRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type,
		row.AmountMl, row.Side, row.DurationMin, row.LeftMin, row.RightMin, row.Notes)
}

func serFeedListRow(row dbgen.ListFeedsRow) gen.FeedLog {
	return serFeedRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Type,
		row.AmountMl, row.Side, row.DurationMin, row.LeftMin, row.RightMin, row.Notes)
}

func feedLogSidePtr(s *string) *gen.FeedLogSide {
	if s == nil {
		return nil
	}
	v := gen.FeedLogSide(*s)
	return &v
}

// listFeedsDefaultLimit mirrors apps/api/src/db/scoped.ts's `opts.limit ??
// 50` — the spec's limitQuery parameter bounds an explicit value (1..200)
// but has no OpenAPI "default", so an omitted limit is resolved here.
const listFeedsDefaultLimit = 50

// ListFeeds implements GET /api/feeds. REF: "FeedLog[] newest first".
func (d Deps) ListFeeds(ctx context.Context, req gen.ListFeedsRequestObject) (gen.ListFeedsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	limit := int32(listFeedsDefaultLimit)
	if req.Params.Limit != nil {
		limit = int32(*req.Params.Limit)
	}

	rows, err := d.Q.ListFeeds(ctx, dbgen.ListFeedsParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      limit,
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

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: body.BabyId}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.CreateFeed404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	var side *string
	if body.Side != nil {
		v := string(*body.Side)
		side = &v
	}

	id, err := d.Q.CreateFeed(ctx, dbgen.CreateFeedParams{
		FamilyID:    fam.FamilyID,
		BabyID:      body.BabyId,
		CaretakerID: fam.UserID,
		Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
		Type:        string(body.Type),
		AmountMl:    body.AmountMl,
		Side:        side,
		DurationMin: body.DurationMin,
		LeftMin:     body.LeftMin,
		RightMin:    body.RightMin,
		Notes:       body.Notes,
	})
	if err != nil {
		return nil, err
	}

	created, err := d.Q.GetFeed(ctx, dbgen.GetFeedParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateFeed201JSONResponse(serFeed(created)), nil
}

// UpdateFeed implements PATCH /api/feeds/{id}. REF: "partial (nullable
// clears) → FeedLog / 404". See this file's package doc comment for the
// presence-detection pattern below — req.Body (the generated strict type)
// is deliberately UNUSED here; rawBodyFields/patchField read the same
// request body a second time, from the copy withRawBody stashed in ctx,
// because only that raw form can tell "omitted" from "explicit null" apart.
func (d Deps) UpdateFeed(ctx context.Context, req gen.UpdateFeedRequestObject) (gen.UpdateFeedResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	existing, err := d.Q.GetFeed(ctx, dbgen.GetFeedParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateFeed404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateFeed")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	typeSet, typeVal, err := patchField[string](fields, "type")
	if err != nil {
		return nil, err
	}
	amountSet, amountVal, err := patchField[int32](fields, "amountMl")
	if err != nil {
		return nil, err
	}
	sideSet, sideVal, err := patchField[string](fields, "side")
	if err != nil {
		return nil, err
	}
	durationSet, durationVal, err := patchField[int32](fields, "durationMin")
	if err != nil {
		return nil, err
	}
	leftSet, leftVal, err := patchField[int32](fields, "leftMin")
	if err != nil {
		return nil, err
	}
	rightSet, rightVal, err := patchField[int32](fields, "rightMin")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}

	if !timeSet && !typeSet && !amountSet && !sideSet && !durationSet && !leftSet && !rightSet && !notesSet {
		return gen.UpdateFeed200JSONResponse(serFeed(existing)), nil
	}

	var timeParam pgtype.Timestamptz
	if timeVal != nil {
		timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
	}

	if _, err := d.Q.UpdateFeed(ctx, dbgen.UpdateFeedParams{
		FamilyID:       fam.FamilyID,
		ID:             req.Id,
		TimeSet:        timeSet,
		TimeVal:        timeParam,
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
		NotesSet:       notesSet,
		NotesVal:       notesVal,
	}); err != nil {
		return nil, err
	}

	updated, err := d.Q.GetFeed(ctx, dbgen.GetFeedParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	return gen.UpdateFeed200JSONResponse(serFeed(updated)), nil
}

// DeleteFeed implements DELETE /api/feeds/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteFeed(ctx context.Context, req gen.DeleteFeedRequestObject) (gen.DeleteFeedResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteFeed(ctx, dbgen.DeleteFeedParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteFeed404JSONResponse(notFound()), nil
	}
	return gen.DeleteFeed200JSONResponse{Ok: gen.OkOkTrue}, nil
}
