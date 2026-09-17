package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// The pick-up handover (issue #106, spec
// docs/superpowers/specs/2026-09-17-daycare-handover-design.md): what the
// staff said, saved as ORDINARY rows so the timeline, the stats, the PDF
// report and the CSV export stay whole with no special cases. A nap is a
// sleep_log row, a meal a solids feed_log row, a nappy a diaper_log row,
// and each carries the day's id as daycare_id.
//
// # The document is a view, not a table
//
// GET rebuilds the Handover from the rows that carry the day's id; there is
// no second copy to drift. A row the family later edits through its own
// sheet stays linked and reads back edited; one they delete is simply gone.
//
// # PUT replaces, in one transaction
//
// Delete the day's linked rows, insert the new ones, set the mood. That
// makes the sheet's edit path its create path, and a replayed offline save
// harmless — the second PUT writes what the first did. It is a real
// transaction (pgx Begin/Commit, the Queries bound with WithTx) because a
// half-replaced handover is a day with its naps deleted and nothing put
// back.
//
// # Whose rows they are
//
// caretaker_id and logged_by_id are NOT NULL and must name a member, and
// the staff are not users. Both take the caller; daycare_id is what says
// who really did it, and the SPA shows "at barnehage" in place of a name.
//
// # Diapers are a count
//
// "Three nappies" has no times. spreadAcross puts the n-th of N at
// start + n·span/(N+1), wet first, so they sit inside the day without
// claiming a precision nobody gave; the link to the day is what tells a
// reader the time is an estimate.

// handoverNapLocation is where a handover nap was slept. One word, written
// by the server in one language on purpose: it is a place name, stored in
// the same free-text column the family's own sleep-location chips write.
const handoverNapLocation = "Barnehage"

// handoverDueWindow is how long after a pick-up Home keeps asking how the
// day went. Twelve hours covers the evening and stops short of the next
// morning's drop-off, when yesterday's handover is nobody's question.
const handoverDueWindow = 12 * time.Hour

func badNap() gen.Error {
	return gen.Error{Error: "A nap must end after it starts", Code: "BAD_NAP"}
}

func outsideDay() gen.Error {
	return gen.Error{Error: "A handover is about the hours she was there: between drop-off and pick-up", Code: "OUTSIDE_DAY"}
}

// dayCovers is the line a handover row must fall inside. A handover is
// about the hours she was THERE, and a row outside them is wrong in a way
// that shows: a usual 11:30 nap saved for a child fetched at 09:30 is a
// sleep in the future, and Home's Awake card counts from its end. The
// sheet speaks in whole minutes, so the drop-off is widened to its minute
// ("from 08:10" on a day that began 08:10:37 is inside); a day still
// running ends now. lib/handover-ui.ts draws the same line.
func dayCovers(day dbgen.GetDaycareRow, now time.Time) func(time.Time) bool {
	start := day.StartTime.Time.Truncate(time.Minute)
	end := now
	if day.EndTime.Valid {
		end = day.EndTime.Time
	}
	return func(t time.Time) bool { return !t.Before(start) && !t.After(end) }
}

// spreadAcross returns n instants evenly inside (start, end).
func spreadAcross(start, end time.Time, n int) []time.Time {
	out := make([]time.Time, n)
	span := end.Sub(start)
	for i := range out {
		out[i] = start.Add(span * time.Duration(i+1) / time.Duration(n+1))
	}
	return out
}

// readHandover rebuilds the document from the day's linked rows.
func readHandover(ctx context.Context, q *dbgen.Queries, familyID string, day dbgen.GetDaycareRow) (gen.Handover, error) {
	key := func() (string, *string) { id := day.ID; return familyID, &id }

	fam, id := key()
	naps, err := q.ListHandoverNaps(ctx, dbgen.ListHandoverNapsParams{FamilyID: fam, DaycareID: id})
	if err != nil {
		return gen.Handover{}, err
	}
	meals, err := q.ListHandoverMeals(ctx, dbgen.ListHandoverMealsParams{FamilyID: fam, DaycareID: id})
	if err != nil {
		return gen.Handover{}, err
	}
	diapers, err := q.CountHandoverDiapers(ctx, dbgen.CountHandoverDiapersParams{FamilyID: fam, DaycareID: id})
	if err != nil {
		return gen.Handover{}, err
	}

	out := gen.Handover{
		Naps:  make([]gen.HandoverNap, len(naps)),
		Meals: make([]gen.HandoverMeal, len(meals)),
		Mood:  enumPtr[gen.HandoverMood](day.Mood),
	}
	out.Diapers.Wet = int(diapers.Wet)
	out.Diapers.Dirty = int(diapers.Dirty)
	for i, n := range naps {
		out.Naps[i] = gen.HandoverNap{StartTime: n.StartTime.Time, EndTime: n.EndTime.Time}
	}
	for i, m := range meals {
		out.Meals[i] = gen.HandoverMeal{
			Time:     m.Time.Time,
			Appetite: enumPtr[gen.HandoverMealAppetite](m.Appetite),
			Food:     m.Food,
		}
	}
	return out, nil
}

// GetDaycareHandover implements GET /api/daycare/{id}/handover. A day
// nobody has described answers the empty document, not a 404: the sheet
// opens on it either way.
func (d Deps) GetDaycareHandover(ctx context.Context, req gen.GetDaycareHandoverRequestObject) (gen.GetDaycareHandoverResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	day, err := d.Q.GetDaycare(ctx, dbgen.GetDaycareParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.GetDaycareHandover404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	out, err := readHandover(ctx, d.Q, fam.FamilyID, day)
	if err != nil {
		return nil, err
	}
	return gen.GetDaycareHandover200JSONResponse(out), nil
}

// PutDaycareHandover implements PUT /api/daycare/{id}/handover — see this
// file's doc comment for why it replaces, and why in one transaction.
func (d Deps) PutDaycareHandover(ctx context.Context, req gen.PutDaycareHandoverRequestObject) (gen.PutDaycareHandoverResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("PutDaycareHandover")
	}
	body := req.Body
	for _, n := range body.Naps {
		if !n.EndTime.After(n.StartTime) {
			return gen.PutDaycareHandover400JSONResponse(badNap()), nil
		}
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	// Read inside the transaction: the day the rows are written for is the
	// day that exists when they are written.
	day, err := qtx.GetDaycare(ctx, dbgen.GetDaycareParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.PutDaycareHandover404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	dayID := &day.ID

	covers := dayCovers(day, d.Now())
	for _, n := range body.Naps {
		if !covers(n.StartTime) || !covers(n.EndTime) {
			return gen.PutDaycareHandover400JSONResponse(outsideDay()), nil
		}
	}
	for _, m := range body.Meals {
		if !covers(m.Time) {
			return gen.PutDaycareHandover400JSONResponse(outsideDay()), nil
		}
	}

	if err := qtx.DeleteHandoverSleeps(ctx, dbgen.DeleteHandoverSleepsParams{FamilyID: fam.FamilyID, DaycareID: dayID}); err != nil {
		return nil, err
	}
	if err := qtx.DeleteHandoverFeeds(ctx, dbgen.DeleteHandoverFeedsParams{FamilyID: fam.FamilyID, DaycareID: dayID}); err != nil {
		return nil, err
	}
	if err := qtx.DeleteHandoverDiapers(ctx, dbgen.DeleteHandoverDiapersParams{FamilyID: fam.FamilyID, DaycareID: dayID}); err != nil {
		return nil, err
	}

	location := handoverNapLocation
	for _, n := range body.Naps {
		if err := qtx.CreateHandoverNap(ctx, dbgen.CreateHandoverNapParams{
			FamilyID: fam.FamilyID, BabyID: day.BabyID, UserID: fam.UserID, DaycareID: dayID,
			StartTime: ts(n.StartTime), EndTime: ts(n.EndTime), Location: &location,
		}); err != nil {
			return nil, err
		}
	}
	for _, m := range body.Meals {
		if err := qtx.CreateHandoverMeal(ctx, dbgen.CreateHandoverMealParams{
			FamilyID: fam.FamilyID, BabyID: day.BabyID, UserID: fam.UserID, DaycareID: dayID,
			Time: ts(m.Time), Appetite: enumStr(m.Appetite), Food: m.Food,
		}); err != nil {
			return nil, err
		}
	}

	// A day still running has no end to spread towards; now is the honest
	// stand-in (a handover mid-day, at tilvenning with a parent present).
	end := d.Now()
	if day.EndTime.Valid {
		end = day.EndTime.Time
	}
	kinds := make([]string, 0, body.Diapers.Wet+body.Diapers.Dirty)
	for range body.Diapers.Wet {
		kinds = append(kinds, "wet")
	}
	for range body.Diapers.Dirty {
		kinds = append(kinds, "dirty")
	}
	for i, at := range spreadAcross(day.StartTime.Time, end, len(kinds)) {
		if err := qtx.CreateHandoverDiaper(ctx, dbgen.CreateHandoverDiaperParams{
			FamilyID: fam.FamilyID, BabyID: day.BabyID, UserID: fam.UserID, DaycareID: dayID,
			Time: ts(at), Type: kinds[i],
		}); err != nil {
			return nil, err
		}
	}

	if err := qtx.SetDaycareMood(ctx, dbgen.SetDaycareMoodParams{FamilyID: fam.FamilyID, ID: day.ID, Mood: enumStr(body.Mood)}); err != nil {
		return nil, err
	}
	day.Mood = enumStr(body.Mood)

	out, err := readHandover(ctx, qtx, fam.FamilyID, day)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return gen.PutDaycareHandover200JSONResponse(out), nil
}
