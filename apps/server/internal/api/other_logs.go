package api

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file is the shared engine behind the six Phase 3 activity types —
// medicine, baths, notes, milestones, measurements, pumps (REF §A1
// "other-logs.ts — makeLogRoutes factory", ports apps/api/src/routes/
// other-logs.ts + apps/api/src/db/scoped.ts's logCrud). Every kind is the
// SAME four-operation shape: GET list, POST create (404 unknown baby),
// PATCH update (tri-state clears, empty-body no-op, 404 unknown id), DELETE
// (404 unknown id) — all free, no plan gate (CLAUDE.md's entitlement
// helper always returns true; the five kinds apps/api gated behind
// "otherActivities" lose that gate here, per Task 12's brief and mirroring
// CreateBaby's own already-removed multipleBabies gate in babies.go).
//
// # Why a smaller shared core instead of one fully generic sqlc-parameterized
// # helper
//
// scoped.ts's logCrud(db, familyId, table, extraCols) is genuinely
// table-generic because Drizzle's query builder can take a PgTable value at
// runtime. sqlc has no equivalent: it emits one concrete Go function and one
// concrete row struct PER QUERY (ListMedicine/ListMedicineRow vs
// ListBaths/ListBathsRow, …), and oapi-codegen does the same one level up —
// every operation's response type (CreateMedicine201JSONResponse vs
// CreateBath201JSONResponse, …) is a distinct named Go type even though
// several are structurally identical (`type X201JSONResponse SomeLog`).
// Neither generates an interface a single generic function could target, so
// a literal "logCrud[T]" parameterized purely by table-specific sqlc funcs
// cannot also construct the operation-specific response objects — those
// have to be built by six thin, concrete wrappers no matter what.
//
// What genuinely IS identical across all six kinds, and therefore what this
// file's three generic functions (createLog/updateLog/deleteLog) capture,
// is the CONTROL FLOW around those sqlc calls: check-baby-then-insert-then-
// reread for create, load-existing-then-maybe-update-then-reread for
// update, delete-then-report-whether-a-row-existed for delete. Each per-kind
// file (medicine.go, baths.go, notes.go, milestones.go, measurements.go,
// pumps.go) supplies that kind's sqlc closures and does nothing else but
// serialize the row and wrap the (Row, ok, err) result in its own concrete
// gen.XxxResponseObject — the "thin instantiations" the brief asks for,
// just built from closures over named sqlc funcs rather than from sqlc funcs
// as literal type parameters. listLimit below is the same "genuinely
// reusable" default-limit-resolution feeds.go/diapers.go already share
// (listFeedsDefaultLimit).
//
// PATCH's per-field patchField[T] calls (patch.go, Task 10) stay in each
// per-kind file: the field SET differs by kind (medicine has
// name/amount/unit, pump has side/amountMl/durationMin, …), so there is
// nothing left to generalize there beyond patchField itself, which is
// already the reusable unit.

// babyExists reports whether babyID exists in familyID, the check every
// CreateX handler below runs before inserting (REF: "404 unknown baby").
func babyExists(ctx context.Context, d Deps, familyID, babyID string) (bool, error) {
	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: familyID, ID: babyID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// listLimit resolves the standard 1..200/default-50 limit convention
// feeds.go's listFeedsDefaultLimit established; req.Params.Limit is nil when
// the query parameter was omitted (spec validation already enforces the
// 1..200 bound when it IS present).
func listLimit(limit *int) int32 {
	if limit != nil {
		return int32(*limit)
	}
	return int32(listFeedsDefaultLimit)
}

// createLog is the generic engine for POST /api/{base}: verify the baby
// exists in the caller's family, run create, then re-read the row via get.
// Returns unknownBaby=true (not an error) when the baby check fails, so
// callers build their own 404 response with their own message/type.
func createLog[Row any](ctx context.Context, d Deps, familyID, babyID string,
	create func(ctx context.Context) (string, error),
	get func(ctx context.Context, id string) (Row, error),
) (row Row, unknownBaby bool, err error) {
	ok, err := babyExists(ctx, d, familyID, babyID)
	if err != nil {
		return row, false, err
	}
	if !ok {
		return row, true, nil
	}
	id, err := create(ctx)
	if err != nil {
		return row, false, err
	}
	row, err = get(ctx, id)
	return row, false, err
}

// updateLog is the generic engine for PATCH /api/{base}/{id}: load the
// existing row (found=false on pgx.ErrNoRows — the 404 case), and — once the
// per-kind handler has already decided via patchField whether ANY field is
// present (anySet) — either skip the UPDATE entirely (an empty patch is a
// no-op, matching scoped.ts's compactPatch/logCrud.update) or run update and
// re-read via the SAME get closure (which reads by the id the caller closed
// over — see medicine.go etc. for the concrete closures).
func updateLog[Row any](ctx context.Context,
	get func(ctx context.Context) (Row, error),
	anySet bool,
	update func(ctx context.Context) error,
) (row Row, found bool, err error) {
	row, err = get(ctx)
	if err != nil {
		var zero Row
		if errors.Is(err, pgx.ErrNoRows) {
			return zero, false, nil
		}
		return zero, false, err
	}
	if !anySet {
		return row, true, nil
	}
	if err = update(ctx); err != nil {
		var zero Row
		return zero, false, err
	}
	row, err = get(ctx)
	return row, true, err
}

// deleteLog is the generic engine for DELETE /api/{base}/{id}: run del and
// report whether a row was actually removed (execrows > 0), the 404 signal
// every per-kind DeleteX handler builds its own response from.
func deleteLog(ctx context.Context, del func(ctx context.Context) (int64, error)) (bool, error) {
	n, err := del(ctx)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
