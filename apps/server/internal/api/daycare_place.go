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

// The barnehage as a place, and who collects her (spec
// docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
// daycare.go is the session — WHERE she is; this is what the place is (how
// to reach it, when it closes) and the family's plan for the pick-up.
//
// # Three small things, one file
//
//   - daycare_place + daycare_enrolment: the place and which babies attend.
//     Parents write (tierAdmin), everyone reads — a grandparent needs the
//     phone number. A baby attends ONE place, so enrolling her is an upsert
//     on the baby and a save REPLACES the place's enrolments in its own
//     transaction (contacts.go's link-set replacement).
//   - daycare_pickup_plan: a Monday-to-Friday grid per baby. PUT replaces
//     it whole, the handover's idempotent shape, so a replayed offline save
//     is harmless.
//   - daycare_pickup_override: someone else collects on one day. Any member
//     may set it, as any member may log the pick-up itself.
//
// # What this file deliberately does not do
//
// It resolves no "today". The expected time and the person are wall-clock
// facts about a local day, and the server has no timezone for a request:
// the summary hands the grid and the exceptions to the client, which has a
// calendar. Only the closing alert (jobs/daycare_closing.go) resolves a
// day, and it does so in the PLACE's zone, which is why a place carries
// one. The expected time fires nothing: it is a plan, not a deadline.

func badTZ() gen.Error {
	return gen.Error{Error: "Not an IANA timezone", Code: "BAD_TZ"}
}

func invalidReference(what string) gen.Error {
	return gen.Error{Error: "Unknown " + what, Code: "INVALID_REFERENCE"}
}

func intPtr32(v *int32) *int {
	if v == nil {
		return nil
	}
	x := int(*v)
	return &x
}

func serDaycarePlace(row dbgen.GetDaycarePlaceRow, babyIDs []string) gen.DaycarePlace {
	if babyIDs == nil {
		babyIDs = []string{}
	}
	return gen.DaycarePlace{
		Id:           row.ID,
		Name:         row.Name,
		Address:      row.Address,
		Phone:        row.Phone,
		Email:        row.Email,
		Website:      row.Website,
		Notes:        row.Notes,
		OpenMinute:   intPtr32(row.OpenMinute),
		CloseMinute:  intPtr32(row.CloseMinute),
		AlertLeadMin: intPtr32(row.AlertLeadMin),
		Tz:           row.Tz,
		BabyIds:      babyIDs,
	}
}

// enrolmentsByPlace groups the family's enrolments by place id.
func (d Deps) enrolmentsByPlace(ctx context.Context, familyID string) (map[string][]string, error) {
	rows, err := d.Q.DaycareEnrolmentsForFamily(ctx, familyID)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]string)
	for _, r := range rows {
		out[r.PlaceID] = append(out[r.PlaceID], r.BabyID)
	}
	return out, nil
}

func (d Deps) getDaycarePlaceHydrated(ctx context.Context, familyID, id string) (gen.DaycarePlace, error) {
	row, err := d.Q.GetDaycarePlace(ctx, dbgen.GetDaycarePlaceParams{FamilyID: familyID, ID: id})
	if err != nil {
		return gen.DaycarePlace{}, err
	}
	byPlace, err := d.enrolmentsByPlace(ctx, familyID)
	if err != nil {
		return gen.DaycarePlace{}, err
	}
	return serDaycarePlace(row, byPlace[id]), nil
}

// ListDaycarePlaces implements GET /api/daycare-places.
func (d Deps) ListDaycarePlaces(ctx context.Context, _ gen.ListDaycarePlacesRequestObject) (gen.ListDaycarePlacesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListDaycarePlaces(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	byPlace, err := d.enrolmentsByPlace(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.DaycarePlace, len(rows))
	for i, row := range rows {
		out[i] = serDaycarePlace(dbgen.GetDaycarePlaceRow(row), byPlace[row.ID])
	}
	return gen.ListDaycarePlaces200JSONResponse(out), nil
}

// placeInput is a validated DaycarePlaceInput: free text trimmed to
// nothing reads as not recorded, the zone loads, the babies are ours.
type placeInput struct {
	body    *gen.DaycarePlaceInput
	babyIDs []string
}

// checkPlaceInput returns a non-nil gen.Error for a 400.
func (d Deps) checkPlaceInput(ctx context.Context, familyID string, body *gen.DaycarePlaceInput) (placeInput, *gen.Error, error) {
	if _, err := time.LoadLocation(body.Tz); err != nil || body.Tz == "Local" {
		e := badTZ()
		return placeInput{}, &e, nil
	}
	babyIDs := uniqueStrings(derefStrSlice(body.BabyIds))
	ok, err := refsValid(ctx, d, familyID, babyIDs, nil)
	if err != nil {
		return placeInput{}, nil, err
	}
	if !ok {
		e := invalidReference("baby")
		return placeInput{}, &e, nil
	}
	return placeInput{body: body, babyIDs: babyIDs}, nil, nil
}

// CreateDaycarePlace implements POST /api/daycare-places.
func (d Deps) CreateDaycarePlace(ctx context.Context, req gen.CreateDaycarePlaceRequestObject) (gen.CreateDaycarePlaceResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateDaycarePlace")
	}
	in, bad, err := d.checkPlaceInput(ctx, fam.FamilyID, req.Body)
	if err != nil {
		return nil, err
	}
	if bad != nil {
		return gen.CreateDaycarePlace400JSONResponse(*bad), nil
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	b := in.body
	id, err := qtx.CreateDaycarePlace(ctx, dbgen.CreateDaycarePlaceParams{
		FamilyID:     fam.FamilyID,
		Name:         b.Name,
		Address:      blankToNil(b.Address),
		Phone:        blankToNil(b.Phone),
		Email:        blankToNil(b.Email),
		Website:      blankToNil(b.Website),
		Notes:        blankToNil(b.Notes),
		OpenMinute:   int32Ptr(b.OpenMinute),
		CloseMinute:  int32Ptr(b.CloseMinute),
		AlertLeadMin: int32Ptr(b.AlertLeadMin),
		Tz:           b.Tz,
	})
	if err != nil {
		return nil, err
	}
	for _, babyID := range in.babyIDs {
		if err := qtx.UpsertDaycareEnrolment(ctx, dbgen.UpsertDaycareEnrolmentParams{BabyID: babyID, FamilyID: fam.FamilyID, PlaceID: id}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	created, err := d.getDaycarePlaceHydrated(ctx, fam.FamilyID, id)
	if err != nil {
		return nil, err
	}
	return gen.CreateDaycarePlace201JSONResponse(created), nil
}

// UpdateDaycarePlace implements PUT /api/daycare-places/{id}.
func (d Deps) UpdateDaycarePlace(ctx context.Context, req gen.UpdateDaycarePlaceRequestObject) (gen.UpdateDaycarePlaceResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("UpdateDaycarePlace")
	}
	in, bad, err := d.checkPlaceInput(ctx, fam.FamilyID, req.Body)
	if err != nil {
		return nil, err
	}
	if bad != nil {
		return gen.UpdateDaycarePlace400JSONResponse(*bad), nil
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	b := in.body
	n, err := qtx.UpdateDaycarePlace(ctx, dbgen.UpdateDaycarePlaceParams{
		FamilyID:     fam.FamilyID,
		ID:           req.Id,
		Name:         b.Name,
		Address:      blankToNil(b.Address),
		Phone:        blankToNil(b.Phone),
		Email:        blankToNil(b.Email),
		Website:      blankToNil(b.Website),
		Notes:        blankToNil(b.Notes),
		OpenMinute:   int32Ptr(b.OpenMinute),
		CloseMinute:  int32Ptr(b.CloseMinute),
		AlertLeadMin: int32Ptr(b.AlertLeadMin),
		Tz:           b.Tz,
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.UpdateDaycarePlace404JSONResponse(notFound()), nil
	}
	// The enrolments are the body's, whole: a baby left out no longer
	// attends, a baby named moves here from wherever she was.
	if err := qtx.DeleteDaycareEnrolmentsForPlace(ctx, dbgen.DeleteDaycareEnrolmentsForPlaceParams{FamilyID: fam.FamilyID, PlaceID: req.Id}); err != nil {
		return nil, err
	}
	for _, babyID := range in.babyIDs {
		if err := qtx.UpsertDaycareEnrolment(ctx, dbgen.UpsertDaycareEnrolmentParams{BabyID: babyID, FamilyID: fam.FamilyID, PlaceID: req.Id}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	updated, err := d.getDaycarePlaceHydrated(ctx, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.UpdateDaycarePlace200JSONResponse(updated), nil
}

// DeleteDaycarePlace implements DELETE /api/daycare-places/{id}. The
// enrolments cascade; a pick-up plan is the baby's and stays.
func (d Deps) DeleteDaycarePlace(ctx context.Context, req gen.DeleteDaycarePlaceRequestObject) (gen.DeleteDaycarePlaceResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteDaycarePlace(ctx, dbgen.DeleteDaycarePlaceParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteDaycarePlace404JSONResponse(notFound()), nil
	}
	return gen.DeleteDaycarePlace200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// pickupPlan reads a baby's grid and her exceptions from yesterday (UTC)
// on. Yesterday rather than today because the server's UTC date can be a
// day ahead of a client west of Greenwich; the client picks its own day.
func (d Deps) pickupPlan(ctx context.Context, familyID, babyID string) (gen.PickupPlan, error) {
	days, err := d.Q.ListPickupPlan(ctx, dbgen.ListPickupPlanParams{FamilyID: familyID, BabyID: babyID})
	if err != nil {
		return gen.PickupPlan{}, err
	}
	from := d.Now().UTC().AddDate(0, 0, -1)
	overrides, err := d.Q.ListPickupOverridesFrom(ctx, dbgen.ListPickupOverridesFromParams{
		FamilyID: familyID,
		BabyID:   babyID,
		FromDate: pgtype.Date{Time: from, Valid: true},
	})
	if err != nil {
		return gen.PickupPlan{}, err
	}
	out := gen.PickupPlan{
		Days:      make([]gen.PickupPlanDay, len(days)),
		Overrides: make([]gen.PickupOverride, len(overrides)),
	}
	for i, day := range days {
		out.Days[i] = gen.PickupPlanDay{Weekday: int(day.Weekday), Minute: intPtr32(day.PickupMinute), UserId: day.UserID}
	}
	for i, o := range overrides {
		out.Overrides[i] = gen.PickupOverride{Date: o.Date.Time.Format(dateLayout), UserId: o.UserID}
	}
	return out, nil
}

// GetPickupPlan implements GET /api/babies/{id}/pickup-plan.
func (d Deps) GetPickupPlan(ctx context.Context, req gen.GetPickupPlanRequestObject) (gen.GetPickupPlanResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	known, err := babyExists(ctx, d, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.GetPickupPlan404JSONResponse(notFound()), nil
	}
	plan, err := d.pickupPlan(ctx, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.GetPickupPlan200JSONResponse(plan), nil
}

// SetPickupPlan implements PUT /api/babies/{id}/pickup-plan.
func (d Deps) SetPickupPlan(ctx context.Context, req gen.SetPickupPlanRequestObject) (gen.SetPickupPlanResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetPickupPlan")
	}
	known, err := babyExists(ctx, d, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.SetPickupPlan404JSONResponse(notFound()), nil
	}

	seen := map[int]bool{}
	var userIDs []string
	for _, day := range req.Body.Days {
		if seen[day.Weekday] {
			return gen.SetPickupPlan400JSONResponse{Error: "A weekday appears twice", Code: "DUPLICATE_DAY"}, nil
		}
		seen[day.Weekday] = true
		if day.UserId != nil {
			userIDs = append(userIDs, *day.UserId)
		}
	}
	ok, err := refsValid(ctx, d, fam.FamilyID, nil, uniqueStrings(userIDs))
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.SetPickupPlan400JSONResponse(invalidReference("caretaker")), nil
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	if err := qtx.DeletePickupPlan(ctx, dbgen.DeletePickupPlanParams{FamilyID: fam.FamilyID, BabyID: req.Id}); err != nil {
		return nil, err
	}
	for _, day := range req.Body.Days {
		if day.Minute == nil && day.UserId == nil {
			continue // an unplanned day is an absent row
		}
		if err := qtx.CreatePickupPlanDay(ctx, dbgen.CreatePickupPlanDayParams{
			FamilyID:     fam.FamilyID,
			BabyID:       req.Id,
			Weekday:      int32(day.Weekday),
			PickupMinute: int32Ptr(day.Minute),
			UserID:       day.UserId,
		}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	plan, err := d.pickupPlan(ctx, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.SetPickupPlan200JSONResponse(plan), nil
}

// SetPickupOverride implements PUT /api/babies/{id}/pickup-override.
func (d Deps) SetPickupOverride(ctx context.Context, req gen.SetPickupOverrideRequestObject) (gen.SetPickupOverrideResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetPickupOverride")
	}
	known, err := babyExists(ctx, d, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.SetPickupOverride404JSONResponse(notFound()), nil
	}
	date, ok := parseDate(req.Body.Date)
	if !ok {
		return gen.SetPickupOverride400JSONResponse(badDate()), nil
	}

	if req.Body.UserId == nil {
		if err := d.Q.DeletePickupOverride(ctx, dbgen.DeletePickupOverrideParams{FamilyID: fam.FamilyID, BabyID: req.Id, Date: date}); err != nil {
			return nil, err
		}
	} else {
		valid, err := refsValid(ctx, d, fam.FamilyID, nil, []string{*req.Body.UserId})
		if err != nil {
			return nil, err
		}
		if !valid {
			return gen.SetPickupOverride400JSONResponse(invalidReference("caretaker")), nil
		}
		if err := d.Q.UpsertPickupOverride(ctx, dbgen.UpsertPickupOverrideParams{FamilyID: fam.FamilyID, BabyID: req.Id, Date: date, UserID: *req.Body.UserId}); err != nil {
			return nil, err
		}
	}

	plan, err := d.pickupPlan(ctx, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.SetPickupOverride200JSONResponse(plan), nil
}

// daycareToday is the summary's `daycare`: the baby's place and her plan,
// or nil when she has neither.
func (d Deps) daycareToday(ctx context.Context, familyID, babyID string) (*gen.DaycareToday, error) {
	plan, err := d.pickupPlan(ctx, familyID, babyID)
	if err != nil {
		return nil, err
	}
	var place *gen.DaycarePlace
	row, err := d.Q.GetDaycarePlaceForBaby(ctx, dbgen.GetDaycarePlaceForBabyParams{FamilyID: familyID, BabyID: babyID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return nil, err
	default:
		byPlace, err := d.enrolmentsByPlace(ctx, familyID)
		if err != nil {
			return nil, err
		}
		p := serDaycarePlace(dbgen.GetDaycarePlaceRow(row), byPlace[row.ID])
		place = &p
	}
	if place == nil && len(plan.Days) == 0 && len(plan.Overrides) == 0 {
		return nil, nil
	}
	return &gen.DaycareToday{Place: place, Plan: plan}, nil
}
