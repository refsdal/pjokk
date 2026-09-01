package api

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file implements GET /api/timeline (REF §A1 timeline.ts): the merged,
// newest-first, keyset-paginated feed across all eleven log kinds (feeds,
// diapers, sleeps, medicine, baths, notes, milestones, measurements, pumps,
// plays, vaccines).
//
// # TimelineEntry's shape: an open object, not a oneOf union
//
// apps/api's TimelineEntrySchema is a zod discriminatedUnion of eleven
// structurally different variants — the wire shape for a "feed" entry
// literally has no "startTime" key, and a "sleep" entry has no "time" key.
// oapi-codegen has no clean Go representation for that: a discriminated
// union isn't a struct. openapi/pjokk.yaml's TimelineEntry schema instead
// types only the six fields every kind actually shares (kind, id, babyId,
// caretakerId, caretakerName, notes — see logBase in packages/shared/src/
// schemas.ts) and marks everything else `additionalProperties: true`,
// which oapi-codegen turns into gen.TimelineEntry.{Get,Set} over a
// map[string]interface{} plus a hand-rolled MarshalJSON/UnmarshalJSON that
// merges the two — see gen/types.gen.go. The per-kind builders below
// (timelineFeedRow, timelineSleepRow, …) each Set() exactly the keys that
// kind's TS serializer would have spread onto the entry, so the JSON that
// comes out the wire is field-for-field what apps/api/src/routes/
// timeline.ts produces — key omitted when the kind doesn't have it, key
// present as `null` when the kind has it and the value happens to be null
// (e.g. a bottle feed's notes).
//
// # Merge, sort, and the keyset cursor
//
// Each source is fetched with its own "Page" query
// (internal/db/queries/timeline.sql) — family+baby scoped, LIMIT'd to the
// SAME page size as everything else, and (when ?before was sent) filtered
// by a keyset cursor via ROW COMPARISON "(t, id) < (cursor_t, cursor_id)".
// Every result is wrapped in a timelineEntryRow carrying an int64
// epoch-millisecond sortKey (sleep/play: startTime; everything else: time),
// all eleven slices are concatenated, and sorted by (sortKey DESC, id DESC)
// — the SAME total order every "Page" query's own ORDER BY uses, which is
// what makes the keyset cursor (built from the LAST entry of the cut page)
// correct: cutting the globally-sorted list at `limit` and asking each
// source for "< this cursor" next time reproduces the next page exactly,
// including when several entries (possibly from different sources) share
// one timestamp — the id tiebreak, matching on both sides, is what
// defects.test.ts's "never drops entries sharing the page-boundary
// timestamp" exercises.
//
// hasMore — and therefore whether a nextCursor is returned at all — is true
// when EITHER the merged, pre-cut list already held more than one page's
// worth (the common case), OR any single source came back with exactly
// `limit` rows (the case a naive "merged length > page length" check
// misses: a single very active source, e.g. one baby's 5 feeds against an
// otherwise-quiet timeline with limit=2, can fill a whole page by itself
// while leaving OLDER rows of that same source unfetched — see
// timeline.test.ts's "including single-kind tails").

// timelineDefaultLimit mirrors apps/api/src/routes/timeline.ts's
// `q.limit ?? 50` — the spec's limit parameter bounds an explicit value
// (1..100) but has no OpenAPI "default", so an omitted limit is resolved
// here, the same convention listFeedsDefaultLimit already established.
const timelineDefaultLimit = 50

// timelineEntryRow pairs one built gen.TimelineEntry with its int64
// epoch-millisecond sort key. The key is kept alongside the entry rather
// than recovered from it because the entry's own time-ish field lives in
// TimelineEntry's untyped AdditionalProperties map, where getting a
// concrete int64 back out would mean a type assertion at every use site.
type timelineEntryRow struct {
	sortKey int64
	entry   gen.TimelineEntry
}

// timelineCursor is the parsed "<epochMs>|<id>" keyset cursor. The zero
// value (CursorTime.Valid == false, CursorID == nil) means "no cursor" —
// every "Page" query's own `cursor_time IS NULL` branch then applies no
// extra filtering, matching TS's `before: undefined`.
type timelineCursor struct {
	time pgtype.Timestamptz
	id   *string
}

// parseTimelineCursor decodes before ("<epochMs>|<id>") into a
// timelineCursor. before is nil when the query param was omitted. The
// spec's `^\d{1,15}\|.{1,64}$` pattern is already enforced by
// withSpecValidation ahead of this handler, so a malformed value here is
// unreachable in practice; parseTimelineCursor degrades to "no cursor"
// rather than panicking if it somehow is reached.
func parseTimelineCursor(before *string) timelineCursor {
	if before == nil {
		return timelineCursor{}
	}
	sep := strings.IndexByte(*before, '|')
	if sep < 0 {
		return timelineCursor{}
	}
	ms, err := strconv.ParseInt((*before)[:sep], 10, 64)
	if err != nil {
		return timelineCursor{}
	}
	id := (*before)[sep+1:]
	return timelineCursor{
		time: pgtype.Timestamptz{Time: time.UnixMilli(ms), Valid: true},
		id:   &id,
	}
}

// timelineBase builds the six fields every TimelineEntry has regardless of
// kind — the wire equivalent of logBase in packages/shared/src/schemas.ts.
func timelineBase(kind gen.TimelineEntryKind, id, babyID, caretakerID, caretakerName string, notes *string) gen.TimelineEntry {
	return gen.TimelineEntry{
		Kind:          kind,
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Notes:         notes,
	}
}

func timelineFeedRow(r dbgen.ListFeedsPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindFeed, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("type", r.Type)
	e.Set("amountMl", r.AmountMl)
	e.Set("side", r.Side)
	e.Set("durationMin", r.DurationMin)
	e.Set("leftMin", r.LeftMin)
	e.Set("rightMin", r.RightMin)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelineDiaperRow(r dbgen.ListDiapersPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindDiaper, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("type", r.Type)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelineSleepRow(r dbgen.ListSleepsPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindSleep, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("startTime", r.StartTime.Time)
	e.Set("endTime", tsPtr(r.EndTime))
	e.Set("location", r.Location)
	return timelineEntryRow{sortKey: r.StartTime.Time.UnixMilli(), entry: e}
}

func timelineMedicineRow(r dbgen.ListMedicinePageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindMedicine, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("name", r.Name)
	e.Set("amount", r.Amount)
	e.Set("unit", r.Unit)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelineBathRow(r dbgen.ListBathsPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindBath, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelineNoteRow(r dbgen.ListNotesPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindNote, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("content", r.Content)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelineMilestoneRow(r dbgen.ListMilestonesPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindMilestone, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("title", r.Title)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelineMeasurementRow(r dbgen.ListMeasurementsPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindMeasurement, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("type", r.Type)
	e.Set("value", r.Value)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelinePumpRow(r dbgen.ListPumpsPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindPump, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("side", r.Side)
	e.Set("amountMl", r.AmountMl)
	e.Set("durationMin", r.DurationMin)
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

func timelinePlayRow(r dbgen.ListPlaysPageRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindPlay, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("type", r.Type)
	e.Set("startTime", r.StartTime.Time)
	e.Set("endTime", tsPtr(r.EndTime))
	return timelineEntryRow{sortKey: r.StartTime.Time.UnixMilli(), entry: e}
}

// timelineVaccineRow takes docs as a parameter rather than hydrating it
// itself, the same shape vaccines.go's serVaccineRow takes — ListTimeline
// batches ListVaccinesPage's whole page through ONE
// ListVaccineDocumentsForLogs call rather than running N+1.
func timelineVaccineRow(r dbgen.ListVaccinesPageRow, docs []dbgen.ListVaccineDocumentsForLogRow) timelineEntryRow {
	e := timelineBase(gen.TimelineEntryKindVaccine, r.ID, r.BabyID, r.CaretakerID, r.CaretakerName, r.Notes)
	e.Set("time", r.Time.Time)
	e.Set("name", r.Name)
	e.Set("doseNumber", r.DoseNumber)
	e.Set("scheduleSlot", r.ScheduleSlot)
	e.Set("documents", serVaccineDocuments(docs))
	return timelineEntryRow{sortKey: r.Time.Time.UnixMilli(), entry: e}
}

// fetchTimelinePage runs run (one source's "Page" query) only when want is
// true — skipped sources contribute an empty (not nil, but zero-length)
// slice, mirroring apps/api/src/routes/timeline.ts's `empty: never[]`
// stand-in for a filtered-out source — and maps every row through mk. The
// per-kind Row types (ListFeedsPageRow, ListSleepsPageRow, …) are all
// structurally different, but the CONTROL FLOW around them (skip-or-run,
// then map) is identical, so a single generic function captures it —
// unlike other_logs.go's createLog/updateLog/deleteLog, this doesn't also
// need to construct a per-operation response object, so there is no
// obstacle to genuinely sharing this one.
func fetchTimelinePage[Row any](ctx context.Context, want bool,
	run func(ctx context.Context) ([]Row, error),
	mk func(Row) timelineEntryRow,
) ([]timelineEntryRow, error) {
	if !want {
		return nil, nil
	}
	rows, err := run(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]timelineEntryRow, len(rows))
	for i, r := range rows {
		out[i] = mk(r)
	}
	return out, nil
}

// ListTimeline implements GET /api/timeline. REF: "{entries, nextCursor} /
// 404 unknown baby" — see this file's doc comment for the full merge/sort/
// cursor/hasMore contract.
func (d Deps) ListTimeline(ctx context.Context, req gen.ListTimelineRequestObject) (gen.ListTimelineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	babyID := req.Params.BabyId

	if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: babyID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.ListTimeline404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
		}
		return nil, err
	}

	limit := int32(timelineDefaultLimit)
	if req.Params.Limit != nil {
		limit = int32(*req.Params.Limit)
	}
	cursor := parseTimelineCursor(req.Params.Before)

	var filter string
	if req.Params.Filter != nil {
		filter = string(*req.Params.Filter)
	}
	// core/other mirror timeline.ts's own `const core = !q.filter` / `const
	// other = !q.filter || q.filter === "other"` exactly.
	core := filter == ""
	other := filter == "" || filter == "other"

	feedRows, err := fetchTimelinePage(ctx, core || filter == "feeds",
		func(ctx context.Context) ([]dbgen.ListFeedsPageRow, error) {
			return d.Q.ListFeedsPage(ctx, dbgen.ListFeedsPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineFeedRow)
	if err != nil {
		return nil, err
	}

	diaperRows, err := fetchTimelinePage(ctx, core || filter == "diapers",
		func(ctx context.Context) ([]dbgen.ListDiapersPageRow, error) {
			return d.Q.ListDiapersPage(ctx, dbgen.ListDiapersPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineDiaperRow)
	if err != nil {
		return nil, err
	}

	sleepRows, err := fetchTimelinePage(ctx, core || filter == "sleep",
		func(ctx context.Context) ([]dbgen.ListSleepsPageRow, error) {
			return d.Q.ListSleepsPage(ctx, dbgen.ListSleepsPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineSleepRow)
	if err != nil {
		return nil, err
	}

	medicineRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListMedicinePageRow, error) {
			return d.Q.ListMedicinePage(ctx, dbgen.ListMedicinePageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineMedicineRow)
	if err != nil {
		return nil, err
	}

	bathRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListBathsPageRow, error) {
			return d.Q.ListBathsPage(ctx, dbgen.ListBathsPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineBathRow)
	if err != nil {
		return nil, err
	}

	noteRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListNotesPageRow, error) {
			return d.Q.ListNotesPage(ctx, dbgen.ListNotesPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineNoteRow)
	if err != nil {
		return nil, err
	}

	milestoneRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListMilestonesPageRow, error) {
			return d.Q.ListMilestonesPage(ctx, dbgen.ListMilestonesPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineMilestoneRow)
	if err != nil {
		return nil, err
	}

	measurementRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListMeasurementsPageRow, error) {
			return d.Q.ListMeasurementsPage(ctx, dbgen.ListMeasurementsPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelineMeasurementRow)
	if err != nil {
		return nil, err
	}

	pumpRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListPumpsPageRow, error) {
			return d.Q.ListPumpsPage(ctx, dbgen.ListPumpsPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelinePumpRow)
	if err != nil {
		return nil, err
	}

	playRows, err := fetchTimelinePage(ctx, other,
		func(ctx context.Context) ([]dbgen.ListPlaysPageRow, error) {
			return d.Q.ListPlaysPage(ctx, dbgen.ListPlaysPageParams{
				FamilyID: fam.FamilyID, BabyID: babyID,
				CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
			})
		}, timelinePlayRow)
	if err != nil {
		return nil, err
	}

	// Vaccines need a second, batched query for their documents — the same
	// divergence ListVaccines (vaccines.go) has — so this source can't go
	// through fetchTimelinePage's single-query shape.
	var vaccineRows []timelineEntryRow
	if other {
		vRows, err := d.Q.ListVaccinesPage(ctx, dbgen.ListVaccinesPageParams{
			FamilyID: fam.FamilyID, BabyID: babyID,
			CursorTime: cursor.time, CursorID: cursor.id, Lim: limit,
		})
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(vRows))
		for i, r := range vRows {
			ids[i] = r.ID
		}
		docRows, err := d.Q.ListVaccineDocumentsForLogs(ctx, dbgen.ListVaccineDocumentsForLogsParams{FamilyID: fam.FamilyID, VaccineLogIds: ids})
		if err != nil {
			return nil, err
		}
		byLog := make(map[string][]dbgen.ListVaccineDocumentsForLogRow, len(vRows))
		for _, dr := range docRows {
			byLog[dr.VaccineLogID] = append(byLog[dr.VaccineLogID], dbgen.ListVaccineDocumentsForLogRow{
				ID: dr.ID, Filename: dr.Filename, ContentType: dr.ContentType, Size: dr.Size,
			})
		}
		vaccineRows = make([]timelineEntryRow, len(vRows))
		for i, r := range vRows {
			vaccineRows[i] = timelineVaccineRow(r, byLog[r.ID])
		}
	}

	sources := [][]timelineEntryRow{
		feedRows, diaperRows, sleepRows, medicineRows, bathRows, noteRows,
		milestoneRows, measurementRows, pumpRows, playRows, vaccineRows,
	}

	merged := make([]timelineEntryRow, 0, len(feedRows)+len(diaperRows)+len(sleepRows)+
		len(medicineRows)+len(bathRows)+len(noteRows)+len(milestoneRows)+
		len(measurementRows)+len(pumpRows)+len(playRows)+len(vaccineRows))
	for _, s := range sources {
		merged = append(merged, s...)
	}

	// Global total order (time DESC, id DESC) — must match every "Page"
	// query's own ORDER BY for the keyset cursor to be correct.
	sort.SliceStable(merged, func(i, j int) bool {
		if merged[i].sortKey != merged[j].sortKey {
			return merged[i].sortKey > merged[j].sortKey
		}
		return merged[i].entry.Id > merged[j].entry.Id
	})

	pageLen := len(merged)
	if pageLen > int(limit) {
		pageLen = int(limit)
	}
	page := merged[:pageLen]

	// More pages exist if the merge already holds more than one page, OR
	// any source filled its own quota (it could have older rows beyond its
	// cut) — see this file's doc comment.
	hasMore := len(merged) > len(page)
	if !hasMore {
		for _, s := range sources {
			if len(s) == int(limit) {
				hasMore = true
				break
			}
		}
	}

	entries := make([]gen.TimelineEntry, len(page))
	for i, p := range page {
		entries[i] = p.entry
	}

	var nextCursor *string
	if hasMore && len(page) > 0 {
		last := page[len(page)-1]
		c := fmt.Sprintf("%d|%s", last.sortKey, last.entry.Id)
		nextCursor = &c
	}

	return gen.ListTimeline200JSONResponse{Entries: entries, NextCursor: nextCursor}, nil
}
