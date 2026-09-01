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

// This file ports apps/api/src/routes/calendar.ts (REF §A1's calendar.ts
// route table): GET/POST /api/calendar/events, PATCH/DELETE
// /api/calendar/events/{id}. contacts.go is the sibling file — same
// tenancy-backstop shape (links.go's refsValid), a simpler PATCH (no
// invariant, no reminder latch) and only one link table instead of two.
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

func serCalendarEvent(id, title string, description, location *string, category string,
	startTime pgtype.Timestamptz, allDay bool, durationMin, remindMinutesBefore *int32,
	createdBy, createdByName string,
	babies []dbgen.CalendarEventBabiesForEventRow, assignees []dbgen.CalendarAssigneesForEventRow,
) gen.CalendarEvent {
	out := gen.CalendarEvent{
		Id:                  id,
		Title:               title,
		Description:         description,
		Location:            location,
		Category:            gen.CalendarEventCategory(category),
		StartTime:           startTime.Time,
		AllDay:              allDay,
		DurationMin:         durationMin,
		RemindMinutesBefore: remindMinutesBefore,
		CreatedBy:           createdBy,
		CreatedByName:       createdByName,
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

func serCalendarEventRow(row dbgen.GetCalendarEventRow, babies []dbgen.CalendarEventBabiesForEventRow, assignees []dbgen.CalendarAssigneesForEventRow) gen.CalendarEvent {
	return serCalendarEvent(row.ID, row.Title, row.Description, row.Location, row.Category,
		row.StartTime, row.AllDay, row.DurationMin, row.RemindMinutesBefore,
		row.CreatedBy, row.CreatedByName, babies, assignees)
}

func serCalendarEventListRow(row dbgen.ListCalendarEventsRow, babies []dbgen.CalendarEventBabiesForEventRow, assignees []dbgen.CalendarAssigneesForEventRow) gen.CalendarEvent {
	return serCalendarEvent(row.ID, row.Title, row.Description, row.Location, row.Category,
		row.StartTime, row.AllDay, row.DurationMin, row.RemindMinutesBefore,
		row.CreatedBy, row.CreatedByName, babies, assignees)
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
	return serCalendarEventRow(row, babies, assignees), nil
}

const maxCalendarRange = 366 * 24 * time.Hour

// ListCalendarEvents implements GET /api/calendar/events. REF: "Events in
// [from, to), ascending by startTime; 400 INVALID_RANGE when to <= from or
// span > 366 days".
func (d Deps) ListCalendarEvents(ctx context.Context, req gen.ListCalendarEventsRequestObject) (gen.ListCalendarEventsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	from, to := req.Params.From, req.Params.To
	if !to.After(from) || to.Sub(from) > maxCalendarRange {
		return gen.ListCalendarEvents400JSONResponse{Error: "Invalid range", Code: "INVALID_RANGE"}, nil
	}

	rows, err := d.Q.ListCalendarEvents(ctx, dbgen.ListCalendarEventsParams{
		FamilyID: fam.FamilyID,
		FromTime: pgtype.Timestamptz{Time: from, Valid: true},
		ToTime:   pgtype.Timestamptz{Time: to, Valid: true},
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

	out := make([]gen.CalendarEvent, len(rows))
	for i, row := range rows {
		out[i] = serCalendarEventListRow(row, babiesByEvent[row.ID], assigneesByEvent[row.ID])
	}
	return gen.ListCalendarEvents200JSONResponse(out), nil
}

// CreateCalendarEvent implements POST /api/calendar/events. REF:
// "{title, description?, location?, category, startTime, allDay,
// durationMin?, remindMinutesBefore?, babyIds[], assigneeUserIds[]} →
// 201; 400 INVALID_REFERENCE on an unknown baby/member". Free — see this
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
		StartTime:           pgtype.Timestamptz{Time: body.StartTime, Valid: true},
		AllDay:              allDay,
		DurationMin:         durationMin,
		RemindMinutesBefore: body.RemindMinutesBefore,
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

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateCalendarEvent")
	}

	titleSet, titleVal, err := patchField[string](fields, "title")
	if err != nil {
		return nil, err
	}
	descSet, descVal, err := patchField[string](fields, "description")
	if err != nil {
		return nil, err
	}
	locSet, locVal, err := patchField[string](fields, "location")
	if err != nil {
		return nil, err
	}
	categorySet, categoryVal, err := patchField[string](fields, "category")
	if err != nil {
		return nil, err
	}
	startSet, startVal, err := patchField[time.Time](fields, "startTime")
	if err != nil {
		return nil, err
	}
	allDaySet, allDayVal, err := patchField[bool](fields, "allDay")
	if err != nil {
		return nil, err
	}
	durationSet, durationVal, err := patchField[int32](fields, "durationMin")
	if err != nil {
		return nil, err
	}
	remindSet, remindVal, err := patchField[int32](fields, "remindMinutesBefore")
	if err != nil {
		return nil, err
	}
	babyIdsSet, babyIdsVal, err := patchField[[]string](fields, "babyIds")
	if err != nil {
		return nil, err
	}
	assigneeIdsSet, assigneeIdsVal, err := patchField[[]string](fields, "assigneeUserIds")
	if err != nil {
		return nil, err
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

	// Moving the event (or its reminder) re-arms the sweep latch.
	rearm := startSet || remindSet

	anySet := titleSet || descSet || locSet || categorySet || startSet || allDaySet || durationSet || remindSet

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	if anySet {
		var startParam pgtype.Timestamptz
		if startVal != nil {
			startParam = pgtype.Timestamptz{Time: *startVal, Valid: true}
		}
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
			StartTimeVal:           startParam,
			AllDaySet:              allDaySet,
			AllDayVal:              allDayVal,
			DurationMinSet:         durationSet,
			DurationMinVal:         durationVal,
			RemindMinutesBeforeSet: remindSet,
			RemindMinutesBeforeVal: remindVal,
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

// DeleteCalendarEvent implements DELETE /api/calendar/events/{id}. REF:
// "{ok:true} / 404". Link rows go with it via ON DELETE CASCADE.
func (d Deps) DeleteCalendarEvent(ctx context.Context, req gen.DeleteCalendarEventRequestObject) (gen.DeleteCalendarEventResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteCalendarEvent(ctx, dbgen.DeleteCalendarEventParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteCalendarEvent404JSONResponse(notFound()), nil
	}
	return gen.DeleteCalendarEvent200JSONResponse{Ok: gen.OkOkTrue}, nil
}
