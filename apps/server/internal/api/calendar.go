package api

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/recur"
)

// # Recurrence (issue #52)
//
// A series is ONE row (recurrence + recurrence_until, 00012). List expands
// it at read time through internal/recur into one CalendarEvent per
// occurrence in [from, to), all sharing the id; startTime is the
// occurrence, seriesStart the stored start. Editing any occurrence edits
// the series ("this occurrence only" is not v1). Changing the rule or its
// end re-arms the reminder latch like a start-time change does.

// This file ports apps/api/src/routes/calendar.ts: GET/POST
// /api/calendar/events, PATCH/DELETE /api/calendar/events/{id}. contacts.go
// is the sibling file — same tenancy-backstop shape (links.go's refsValid), a
// simpler PATCH (no invariant, no reminder latch) and only one link table
// instead of two.
//
// # Divergence: no billing gate
//
// apps/api/src/routes/calendar.ts soft-locks POST behind canUse(family,
// "calendar") (premium). CLAUDE.md's entitlement helper always returns
// true on this port (see other_logs.go's package doc comment, which
// removed the same gate for the six Phase 3 kinds) — event create is free
// here, with no 402 path at all.
//
// # Link-set replacement: one transaction
//
// calendar_event_baby/calendar_assignee carry no family_id of their own,
// so babyIds/assigneeUserIds are checked against this family (links.go's
// refsValid) before ever being inserted. Create commits the event row and
// both link sets in one transaction; update commits the column patch and
// BOTH link replacements (delete-then-reinsert) in the SAME transaction —
// apps/api/src/db/scoped.ts's comment on updateCalendarEvent calls this
// out explicitly: "a reminder sweep reading between the two writes could
// notify a stale assignee list."
//
// # The allDay/durationMin invariant
//
// An all-day event never carries a duration. apps/api/src/routes/
// calendar.ts computes `effectiveAllDay := body.allDay ?? existing.allDay`
// and then ALWAYS writes durationMin as `effectiveAllDay ? null :
// body.durationMin` — note this is unconditional, not just "when allDay is
// being set": an already-all-day event has durationMin forced back to null
// on EVERY PATCH, even one that never mentions either field, and even one
// that explicitly tries to set durationMin (case (b) in calendar_test.go's
// TestUpdateCalendarEventAllDayDurationInvariant). UpdateCalendarEvent
// below reproduces that exactly: durationMinSet/durationMinVal are forced
// to (true, nil) whenever effectiveAllDay is true, overriding whatever the
// client's own durationMin patchField decoded to.
//
// # The reminder latch
//
// remindedAt (00001_init.sql) is the reminder sweep's idempotency latch —
// never client-settable directly. Changing startTime or
// remindMinutesBefore re-arms it (clears it back to NULL) so a
// already-sent reminder fires again for the new time/lead; UpdateCalendarEvent's
// clear_reminded_at parameter (queries/calendar.sql) is that reset,
// computed here as `startTimeSet || remindMinutesBeforeSet`.

// serCalendarEvent converts one calendar_event row, plus its baby and
// assignee join rows, into the wire shape. GetCalendarEvent and
// ListCalendarEvents produce two names for the event row; callers holding
// the other convert (see convert.go).
func serCalendarEvent(row dbgen.GetCalendarEventRow,
	babies []dbgen.CalendarEventBabiesForEventRow, assignees []dbgen.CalendarAssigneesForEventRow,
) gen.CalendarEvent {
	out := gen.CalendarEvent{
		Id:                  row.ID,
		Title:               row.Title,
		Description:         row.Description,
		Location:            row.Location,
		Category:            gen.CalendarEventCategory(row.Category),
		StartTime:           row.StartTime.Time,
		SeriesStart:         row.StartTime.Time,
		Recurrence:          gen.CalendarEventRecurrence(row.Recurrence),
		RecurrenceUntil:     tsPtr(row.RecurrenceUntil),
		AllDay:              row.AllDay,
		DurationMin:         row.DurationMin,
		RemindMinutesBefore: row.RemindMinutesBefore,
		CreatedBy:           row.CreatedBy,
		CreatedByName:       row.CreatedByName,
		Babies: make([]struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}, len(babies)),
		Assignees: make([]struct {
			Name   string `json:"name"`
			UserId string `json:"userId"`
		}, len(assignees)),
	}
	for i, b := range babies {
		out.Babies[i] = struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}{Id: b.ID, Name: b.Name}
	}
	for i, a := range assignees {
		out.Assignees[i] = struct {
			Name   string `json:"name"`
			UserId string `json:"userId"`
		}{Name: a.Name, UserId: a.UserID}
	}
	return out
}

// seriesOf is the recur view of a stored row.
func seriesOf(start pgtype.Timestamptz, recurrence string, until pgtype.Timestamptz) recur.Series {
	s := recur.Series{Start: start.Time, Rule: recur.Rule(recurrence)}
	if until.Valid {
		u := until.Time
		s.Until = &u
	}
	return s
}

// skipsByEvent reads the skipped occurrences of the given events
// (00016_calendar_event_skip.sql), keyed by event.
func (d Deps) skipsByEvent(ctx context.Context, familyID string, ids []string) (map[string][]time.Time, error) {
	out := map[string][]time.Time{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := d.Q.CalendarEventSkipsForEvents(ctx, dbgen.CalendarEventSkipsForEventsParams{FamilyID: familyID, EventIds: ids})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.EventID] = append(out[r.EventID], r.OccurrenceStart.Time)
	}
	return out, nil
}

// storedSeries is one event's series with its skips — what an
// "occurrence" parameter is checked against.
func (d Deps) storedSeries(ctx context.Context, familyID string, row dbgen.GetCalendarEventRow) (recur.Series, error) {
	s := seriesOf(row.StartTime, row.Recurrence, row.RecurrenceUntil)
	skips, err := d.Q.CalendarEventSkipsForEvent(ctx, dbgen.CalendarEventSkipsForEventParams{FamilyID: familyID, EventID: row.ID})
	if err != nil {
		return s, err
	}
	for _, k := range skips {
		s.Skip = append(s.Skip, k.Time)
	}
	return s, nil
}

func notAnOccurrence() gen.Error {
	return gen.Error{Error: "That is not an occurrence of a recurring event", Code: "NOT_AN_OCCURRENCE"}
}

// detachedEvent is what "edit this event" turns one occurrence into: a
// standalone event with the series' fields and the patch applied.
type detachedEvent struct {
	title       string
	description *string
	location    *string
	category    string
	start       time.Time
	allDay      bool
	durationMin *int32
	remind      *int32
	babyIDs     []string
	assigneeIDs []string
}

// detachOccurrence takes one occurrence out of a series and creates the
// standalone event that replaces it, in one transaction, and returns the
// new event. It keeps the series' creator: the detached event is the same
// plan, moved.
func (d Deps) detachOccurrence(ctx context.Context, familyID string, series dbgen.GetCalendarEventRow, occurrence time.Time, e detachedEvent) (gen.CalendarEvent, error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return gen.CalendarEvent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	newID, err := qtx.CreateCalendarEvent(ctx, dbgen.CreateCalendarEventParams{
		FamilyID:            familyID,
		CreatedBy:           series.CreatedBy,
		Title:               e.title,
		Description:         e.description,
		Location:            e.location,
		Category:            e.category,
		StartTime:           ts(e.start),
		AllDay:              e.allDay,
		DurationMin:         e.durationMin,
		RemindMinutesBefore: e.remind,
		Recurrence:          string(recur.None),
	})
	if err != nil {
		return gen.CalendarEvent{}, err
	}
	for _, babyID := range e.babyIDs {
		if err := qtx.CreateCalendarEventBaby(ctx, dbgen.CreateCalendarEventBabyParams{EventID: newID, BabyID: babyID}); err != nil {
			return gen.CalendarEvent{}, err
		}
	}
	for _, userID := range e.assigneeIDs {
		if err := qtx.CreateCalendarAssignee(ctx, dbgen.CreateCalendarAssigneeParams{EventID: newID, UserID: userID}); err != nil {
			return gen.CalendarEvent{}, err
		}
	}
	if err := qtx.CreateCalendarEventSkip(ctx, dbgen.CreateCalendarEventSkipParams{
		FamilyID: familyID, EventID: series.ID, OccurrenceStart: ts(occurrence),
	}); err != nil {
		return gen.CalendarEvent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return gen.CalendarEvent{}, err
	}
	return d.getCalendarEventHydrated(ctx, familyID, newID)
}

// getCalendarEventHydrated re-reads one event plus both hydrated link
// sets — the shared re-read Create/Update use after a write.
func (d Deps) getCalendarEventHydrated(ctx context.Context, familyID, id string) (gen.CalendarEvent, error) {
	row, err := d.Q.GetCalendarEvent(ctx, dbgen.GetCalendarEventParams{FamilyID: familyID, ID: id})
	if err != nil {
		return gen.CalendarEvent{}, err
	}
	babies, err := d.Q.CalendarEventBabiesForEvent(ctx, id)
	if err != nil {
		return gen.CalendarEvent{}, err
	}
	assignees, err := d.Q.CalendarAssigneesForEvent(ctx, id)
	if err != nil {
		return gen.CalendarEvent{}, err
	}
	return serCalendarEvent(row, babies, assignees), nil
}

const maxCalendarRange = 366 * 24 * time.Hour

// ListCalendarEvents implements GET /api/calendar/events. Events in
// [from, to), ascending by startTime; 400 INVALID_RANGE when to <= from or
// span > 366 days.
func (d Deps) ListCalendarEvents(ctx context.Context, req gen.ListCalendarEventsRequestObject) (gen.ListCalendarEventsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	from, to := req.Params.From, req.Params.To
	if !to.After(from) || to.Sub(from) > maxCalendarRange {
		return gen.ListCalendarEvents400JSONResponse{Error: "Invalid range", Code: "INVALID_RANGE"}, nil
	}

	rows, err := d.Q.ListCalendarEvents(ctx, dbgen.ListCalendarEventsParams{
		FamilyID: fam.FamilyID,
		FromTime: ts(from),
		ToTime:   ts(to),
	})
	if err != nil {
		return nil, err
	}

	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	var babyRows []dbgen.CalendarEventBabiesForEventsRow
	var assigneeRows []dbgen.CalendarAssigneesForEventsRow
	if len(ids) > 0 {
		babyRows, err = d.Q.CalendarEventBabiesForEvents(ctx, ids)
		if err != nil {
			return nil, err
		}
		assigneeRows, err = d.Q.CalendarAssigneesForEvents(ctx, ids)
		if err != nil {
			return nil, err
		}
	}
	babiesByEvent := make(map[string][]dbgen.CalendarEventBabiesForEventRow, len(rows))
	for _, br := range babyRows {
		babiesByEvent[br.EventID] = append(babiesByEvent[br.EventID], dbgen.CalendarEventBabiesForEventRow{ID: br.ID, Name: br.Name})
	}
	assigneesByEvent := make(map[string][]dbgen.CalendarAssigneesForEventRow, len(rows))
	for _, ar := range assigneeRows {
		assigneesByEvent[ar.EventID] = append(assigneesByEvent[ar.EventID], dbgen.CalendarAssigneesForEventRow{UserID: ar.UserID, Name: ar.Name})
	}

	skips, err := d.skipsByEvent(ctx, fam.FamilyID, ids)
	if err != nil {
		return nil, err
	}

	// One entry per occurrence in the window: a one-off is its own single
	// occurrence, a series fans out (less its skipped occurrences), and the
	// merged list is re-sorted because a series row sorts by its stored
	// start, not its occurrences.
	out := make([]gen.CalendarEvent, 0, len(rows))
	for _, row := range rows {
		base := serCalendarEvent(dbgen.GetCalendarEventRow(row), babiesByEvent[row.ID], assigneesByEvent[row.ID])
		series := seriesOf(row.StartTime, row.Recurrence, row.RecurrenceUntil)
		series.Skip = skips[row.ID]
		for _, occ := range series.Between(from, to) {
			e := base
			// recur steps in Oslo; the wire is UTC like every other timestamp.
			e.StartTime = occ.UTC()
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].StartTime.Equal(out[j].StartTime) {
			return out[i].StartTime.Before(out[j].StartTime)
		}
		return out[i].Id < out[j].Id
	})
	return gen.ListCalendarEvents200JSONResponse(out), nil
}

// CreateCalendarEvent implements POST /api/calendar/events.
// {title, description?, location?, category, startTime, allDay,
// durationMin?, remindMinutesBefore?, babyIds[], assigneeUserIds[]} →
// 201; 400 INVALID_REFERENCE on an unknown baby/member. Free — see this
// file's doc comment for why there is no 402 path.
func (d Deps) CreateCalendarEvent(ctx context.Context, req gen.CreateCalendarEventRequestObject) (gen.CreateCalendarEventResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateCalendarEvent")
	}
	body := req.Body

	babyIDs := uniqueStrings(derefStrSlice(body.BabyIds))
	assigneeIDs := uniqueStrings(derefStrSlice(body.AssigneeUserIds))

	ok, err := refsValid(ctx, d, fam.FamilyID, babyIDs, assigneeIDs)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.CreateCalendarEvent400JSONResponse{Error: "Unknown baby or member", Code: "INVALID_REFERENCE"}, nil
	}

	category := gen.CreateCalendarEventCategoryOther
	if body.Category != nil {
		category = *body.Category
	}
	allDay := false
	if body.AllDay != nil {
		allDay = *body.AllDay
	}
	durationMin := body.DurationMin
	if allDay {
		durationMin = nil
	}
	recurrence := string(gen.CreateCalendarEventRecurrenceNone)
	if body.Recurrence != nil {
		recurrence = string(*body.Recurrence)
	}
	var until pgtype.Timestamptz
	if recurrence != string(recur.None) && body.RecurrenceUntil != nil {
		until = ts(*body.RecurrenceUntil)
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	id, err := qtx.CreateCalendarEvent(ctx, dbgen.CreateCalendarEventParams{
		FamilyID:            fam.FamilyID,
		CreatedBy:           fam.UserID,
		Title:               body.Title,
		Description:         body.Description,
		Location:            body.Location,
		Category:            string(category),
		StartTime:           ts(body.StartTime),
		AllDay:              allDay,
		DurationMin:         durationMin,
		RemindMinutesBefore: body.RemindMinutesBefore,
		Recurrence:          recurrence,
		RecurrenceUntil:     until,
	})
	if err != nil {
		return nil, err
	}
	for _, babyID := range babyIDs {
		if err := qtx.CreateCalendarEventBaby(ctx, dbgen.CreateCalendarEventBabyParams{EventID: id, BabyID: babyID}); err != nil {
			return nil, err
		}
	}
	for _, userID := range assigneeIDs {
		if err := qtx.CreateCalendarAssignee(ctx, dbgen.CreateCalendarAssigneeParams{EventID: id, UserID: userID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	created, err := d.getCalendarEventHydrated(ctx, fam.FamilyID, id)
	if err != nil {
		return nil, err
	}
	return gen.CreateCalendarEvent201JSONResponse(created), nil
}

// UpdateCalendarEvent implements PATCH /api/calendar/events/{id}. See
// this file's doc comment for the allDay/durationMin invariant and the
// reminder-latch reset this handler enforces.
func (d Deps) UpdateCalendarEvent(ctx context.Context, req gen.UpdateCalendarEventRequestObject) (gen.UpdateCalendarEventResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	existing, err := d.Q.GetCalendarEvent(ctx, dbgen.GetCalendarEventParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateCalendarEvent404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	p, err := patchBody(ctx, "UpdateCalendarEvent")
	if err != nil {
		return nil, err
	}

	titleSet, titleVal := patchField[string](p, "title")
	descSet, descVal := patchField[string](p, "description")
	locSet, locVal := patchField[string](p, "location")
	categorySet, categoryVal := patchField[string](p, "category")
	startSet, startVal := patchField[time.Time](p, "startTime")
	allDaySet, allDayVal := patchField[bool](p, "allDay")
	durationSet, durationVal := patchField[int32](p, "durationMin")
	remindSet, remindVal := patchField[int32](p, "remindMinutesBefore")
	babyIdsSet, babyIdsVal := patchField[[]string](p, "babyIds")
	assigneeIdsSet, assigneeIdsVal := patchField[[]string](p, "assigneeUserIds")
	recurrenceSet, recurrenceVal := patchField[string](p, "recurrence")
	untilSet, untilVal := patchField[time.Time](p, "recurrenceUntil")
	if err := p.Err(); err != nil {
		return nil, err
	}
	// The spec forbids a null recurrence; treat one as "none" rather than
	// writing NULL into a NOT NULL column.
	recurrenceStr := string(recur.None)
	if recurrenceVal != nil {
		recurrenceStr = *recurrenceVal
	}
	// Turning a series back into a one-off drops its end date too.
	if recurrenceSet && recurrenceStr == string(recur.None) {
		untilSet, untilVal = true, nil
	}

	var babyIDs, assigneeIDs []string
	if babyIdsSet {
		if babyIdsVal != nil {
			babyIDs = uniqueStrings(*babyIdsVal)
		}
	}
	if assigneeIdsSet {
		if assigneeIdsVal != nil {
			assigneeIDs = uniqueStrings(*assigneeIdsVal)
		}
	}
	ok, err := refsValid(ctx, d, fam.FamilyID, babyIDs, assigneeIDs)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.UpdateCalendarEvent400JSONResponse{Error: "Unknown baby or member", Code: "INVALID_REFERENCE"}, nil
	}

	// The invariant must hold against the RESULTING state, not just an
	// incoming allDay:true — see this file's doc comment. durationMin is
	// therefore ALWAYS forced to (set=true, val=nil) once the event is (or
	// becomes) all-day, overriding whatever the client's own durationMin
	// patch decoded to.
	effectiveAllDay := existing.AllDay
	if allDaySet && allDayVal != nil {
		effectiveAllDay = *allDayVal
	}
	if effectiveAllDay {
		durationSet, durationVal = true, nil
	}

	// "Edit this event": that occurrence leaves the series as a standalone
	// event carrying the patch over the series' fields. Recurrence fields
	// are ignored — a single occurrence does not repeat.
	if req.Params.Occurrence != nil {
		occurrence := *req.Params.Occurrence
		series, err := d.storedSeries(ctx, fam.FamilyID, existing)
		if err != nil {
			return nil, err
		}
		if !series.IsOccurrence(occurrence) {
			return gen.UpdateCalendarEvent400JSONResponse(notAnOccurrence()), nil
		}
		e := detachedEvent{
			title:       existing.Title,
			description: existing.Description,
			location:    existing.Location,
			category:    existing.Category,
			start:       occurrence,
			allDay:      effectiveAllDay,
			durationMin: existing.DurationMin,
			remind:      existing.RemindMinutesBefore,
			babyIDs:     babyIDs,
			assigneeIDs: assigneeIDs,
		}
		if titleSet && titleVal != nil {
			e.title = *titleVal
		}
		if descSet {
			e.description = descVal
		}
		if locSet {
			e.location = locVal
		}
		if categorySet && categoryVal != nil {
			e.category = *categoryVal
		}
		if startSet && startVal != nil {
			e.start = *startVal
		}
		if durationSet {
			e.durationMin = durationVal
		}
		if remindSet {
			e.remind = remindVal
		}
		if !babyIdsSet {
			rows, err := d.Q.CalendarEventBabiesForEvent(ctx, existing.ID)
			if err != nil {
				return nil, err
			}
			for _, r := range rows {
				e.babyIDs = append(e.babyIDs, r.ID)
			}
		}
		if !assigneeIdsSet {
			rows, err := d.Q.CalendarAssigneesForEvent(ctx, existing.ID)
			if err != nil {
				return nil, err
			}
			for _, r := range rows {
				e.assigneeIDs = append(e.assigneeIDs, r.UserID)
			}
		}
		detached, err := d.detachOccurrence(ctx, fam.FamilyID, existing, occurrence, e)
		if err != nil {
			return nil, err
		}
		return gen.UpdateCalendarEvent200JSONResponse(detached), nil
	}

	// Moving the event (or its reminder, or its recurrence) re-arms the
	// sweep latch.
	rearm := startSet || remindSet || recurrenceSet || untilSet

	// The event row's own columns, as distinct from p.Any(): a patch
	// carrying only babyIds/assigneeUserIds writes join tables only.
	rowSet := titleSet || descSet || locSet || categorySet || startSet || allDaySet || durationSet || remindSet || recurrenceSet || untilSet

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	if rowSet {
		n, err := qtx.UpdateCalendarEvent(ctx, dbgen.UpdateCalendarEventParams{
			FamilyID:               fam.FamilyID,
			ID:                     req.Id,
			TitleSet:               titleSet,
			TitleVal:               titleVal,
			DescriptionSet:         descSet,
			DescriptionVal:         descVal,
			LocationSet:            locSet,
			LocationVal:            locVal,
			CategorySet:            categorySet,
			CategoryVal:            categoryVal,
			StartTimeSet:           startSet,
			StartTimeVal:           tsFrom(startVal),
			AllDaySet:              allDaySet,
			AllDayVal:              allDayVal,
			DurationMinSet:         durationSet,
			DurationMinVal:         durationVal,
			RemindMinutesBeforeSet: remindSet,
			RemindMinutesBeforeVal: remindVal,
			RecurrenceSet:          recurrenceSet,
			RecurrenceVal:          recurrenceStr,
			RecurrenceUntilSet:     untilSet,
			RecurrenceUntilVal:     tsFrom(untilVal),
			ClearRemindedAt:        rearm,
		})
		if err != nil {
			return nil, err
		}
		// Re-check ownership against the UPDATE's own row count rather than
		// trusting the pre-check (existing, fetched above) alone: a
		// concurrent delete between that check and this transaction's
		// UPDATE would otherwise write nothing and still report success.
		// Mirrors apps/api/src/db/scoped.ts's updateCalendarEvent, which
		// treats a zero-row update the same as the "not found" branch of
		// its own ownership check.
		if n == 0 {
			return gen.UpdateCalendarEvent404JSONResponse(notFound()), nil
		}
		// A moved start or a new rule makes a different set of
		// occurrences: the skips named the old ones, so they go. Only a
		// real change counts — the sheet sends startTime on every save.
		startMoved := startSet && startVal != nil && !startVal.Equal(existing.StartTime.Time)
		ruleChanged := recurrenceSet && recurrenceStr != existing.Recurrence
		if startMoved || ruleChanged {
			if err := qtx.DeleteCalendarEventSkips(ctx, dbgen.DeleteCalendarEventSkipsParams{FamilyID: fam.FamilyID, EventID: req.Id}); err != nil {
				return nil, err
			}
		}
	}

	if babyIdsSet {
		if err := qtx.DeleteCalendarEventBabies(ctx, req.Id); err != nil {
			return nil, err
		}
		for _, babyID := range babyIDs {
			if err := qtx.CreateCalendarEventBaby(ctx, dbgen.CreateCalendarEventBabyParams{EventID: req.Id, BabyID: babyID}); err != nil {
				return nil, err
			}
		}
	}
	if assigneeIdsSet {
		if err := qtx.DeleteCalendarAssignees(ctx, req.Id); err != nil {
			return nil, err
		}
		for _, userID := range assigneeIDs {
			if err := qtx.CreateCalendarAssignee(ctx, dbgen.CreateCalendarAssigneeParams{EventID: req.Id, UserID: userID}); err != nil {
				return nil, err
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	updated, err := d.getCalendarEventHydrated(ctx, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.UpdateCalendarEvent200JSONResponse(updated), nil
}

// DeleteCalendarEvent implements DELETE /api/calendar/events/{id}.
// {ok:true} / 404. Link rows go with it via ON DELETE CASCADE.
func (d Deps) DeleteCalendarEvent(ctx context.Context, req gen.DeleteCalendarEventRequestObject) (gen.DeleteCalendarEventResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	// "Delete this event": the occurrence is skipped; the series stays.
	if req.Params.Occurrence != nil {
		existing, err := d.Q.GetCalendarEvent(ctx, dbgen.GetCalendarEventParams{FamilyID: fam.FamilyID, ID: req.Id})
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.DeleteCalendarEvent404JSONResponse(notFound()), nil
		}
		if err != nil {
			return nil, err
		}
		series, err := d.storedSeries(ctx, fam.FamilyID, existing)
		if err != nil {
			return nil, err
		}
		if !series.IsOccurrence(*req.Params.Occurrence) {
			return gen.DeleteCalendarEvent400JSONResponse(notAnOccurrence()), nil
		}
		if err := d.Q.CreateCalendarEventSkip(ctx, dbgen.CreateCalendarEventSkipParams{
			FamilyID: fam.FamilyID, EventID: req.Id, OccurrenceStart: ts(*req.Params.Occurrence),
		}); err != nil {
			return nil, err
		}
		return gen.DeleteCalendarEvent200JSONResponse{Ok: gen.OkOkTrue}, nil
	}
	n, err := d.Q.DeleteCalendarEvent(ctx, dbgen.DeleteCalendarEventParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteCalendarEvent404JSONResponse(notFound()), nil
	}
	return gen.DeleteCalendarEvent200JSONResponse{Ok: gen.OkOkTrue}, nil
}
