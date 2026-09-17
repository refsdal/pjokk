package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	"github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Days at home with an ill child (issue #108, spec
// docs/superpowers/specs/2026-09-17-illness-and-care-days-design.md).
// Norway's «sykt barn-dager» are a yearly quota per employee; this counts
// what each person has used against a number THEY set.
//
// # What this file deliberately does not do
//
// It computes no entitlement. NAV's rule (10 days with one or two children,
// 15 with three or more, doubled for a sole carer) depends on things the app
// does not know, and being wrong about someone's leave is not a harmless
// bug. care_day_quota has no default: a person who has set no number sees
// "4 days", not "4 of 10". The rule is reference text in the SPA.
//
// # A date, not an instant
//
// `date` crosses the wire as YYYY-MM-DD and is stored as a Postgres date.
// Whose leave it was is a fact about a day on a payslip; the client sends
// its own local day and the server, which has no timezone, never derives
// one from a timestamp. The year window is a pair of dates for the same
// reason.
//
// # Whose rows
//
// Any member may record a day for any member — a parent logs the other's
// day at home exactly as they log the other's nappy change — but only a
// member (403 NOT_MEMBER, caretakerFor's rule). The yearly number is
// personal: one's own, or anyone's as a family admin.

const dateLayout = "2006-01-02"

func badDate() gen.Error {
	return gen.Error{Error: "Not a calendar date (YYYY-MM-DD)", Code: "BAD_DATE"}
}

func duplicateCareDay() gen.Error {
	return gen.Error{Error: "That person already has a day at home on that date", Code: "DUPLICATE"}
}

// parseDate accepts exactly one calendar date. The spec's pattern has
// already checked the shape; this refuses the shapes that are not days
// (2026-02-30).
func parseDate(s string) (pgtype.Date, bool) {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return pgtype.Date{}, false
	}
	return pgtype.Date{Time: t, Valid: true}, true
}

func serCareDay(row dbgen.GetCareDayRow) gen.CareDay {
	return gen.CareDay{
		Id:        row.ID,
		UserId:    row.UserID,
		UserName:  row.UserName,
		BabyId:    row.BabyID,
		IllnessId: row.IllnessID,
		Date:      row.Date.Time.Format(dateLayout),
		Fraction:  gen.CareDayFraction(row.Fraction),
		Note:      row.Note,
	}
}

// ListCareDays implements GET /api/care-days?year=.
func (d Deps) ListCareDays(ctx context.Context, req gen.ListCareDaysRequestObject) (gen.ListCareDaysResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	year := req.Params.Year
	from := pgtype.Date{Time: time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC), Valid: true}
	to := pgtype.Date{Time: time.Date(year, time.December, 31, 0, 0, 0, 0, time.UTC), Valid: true}

	rows, err := d.Q.ListCareDays(ctx, dbgen.ListCareDaysParams{FamilyID: fam.FamilyID, FromDate: from, ToDate: to})
	if err != nil {
		return nil, err
	}
	totals, err := d.Q.CareDayTotals(ctx, dbgen.CareDayTotalsParams{FamilyID: fam.FamilyID, FromDate: from, ToDate: to})
	if err != nil {
		return nil, err
	}
	out := gen.CareDays{
		Year:   year,
		Days:   make([]gen.CareDay, len(rows)),
		Totals: make([]gen.CareDayTotal, len(totals)),
	}
	for i, row := range rows {
		out.Days[i] = serCareDay(dbgen.GetCareDayRow(row))
	}
	for i, t := range totals {
		var quota *int
		if t.Quota != nil {
			v := int(*t.Quota)
			quota = &v
		}
		out.Totals[i] = gen.CareDayTotal{UserId: t.UserID, UserName: t.UserName, Used: float32(t.Used), Quota: quota}
	}
	return gen.ListCareDays200JSONResponse(out), nil
}

// CreateCareDay implements POST /api/care-days.
func (d Deps) CreateCareDay(ctx context.Context, req gen.CreateCareDayRequestObject) (gen.CreateCareDayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateCareDay")
	}
	body := req.Body

	date, ok := parseDate(body.Date)
	if !ok {
		return gen.CreateCareDay400JSONResponse(badDate()), nil
	}
	userID, notMember, err := caretakerFor(ctx, d, fam, body.UserId)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.CreateCareDay403JSONResponse(notMemberErr()), nil
	}

	babyID := body.BabyId
	if body.IllnessId != nil {
		// The illness must be this family's, and lends the day its baby
		// unless the body names one.
		illBaby, err := d.Q.CareDayIllnessInFamily(ctx, dbgen.CareDayIllnessInFamilyParams{FamilyID: fam.FamilyID, ID: *body.IllnessId})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gen.CreateCareDay404JSONResponse(notFound()), nil
			}
			return nil, err
		}
		if babyID == nil {
			babyID = &illBaby
		}
	}
	if babyID != nil {
		known, err := babyExists(ctx, d, fam.FamilyID, *babyID)
		if err != nil {
			return nil, err
		}
		if !known {
			return gen.CreateCareDay404JSONResponse(unknownBabyErr()), nil
		}
	}

	fraction := 1.0
	if body.Fraction != nil {
		fraction = float64(*body.Fraction)
	}
	id, err := d.Q.CreateCareDay(ctx, dbgen.CreateCareDayParams{
		FamilyID:  fam.FamilyID,
		UserID:    userID,
		BabyID:    babyID,
		IllnessID: body.IllnessId,
		Date:      date,
		Fraction:  fraction,
		Note:      body.Note,
	})
	if err != nil {
		if db.IsUniqueViolation(err) {
			return gen.CreateCareDay409JSONResponse(duplicateCareDay()), nil
		}
		return nil, err
	}
	created, err := d.Q.GetCareDay(ctx, dbgen.GetCareDayParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}
	return gen.CreateCareDay201JSONResponse(serCareDay(created)), nil
}

// UpdateCareDay implements PATCH /api/care-days/{id}.
func (d Deps) UpdateCareDay(ctx context.Context, req gen.UpdateCareDayRequestObject) (gen.UpdateCareDayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	p, err := patchBody(ctx, "UpdateCareDay")
	if err != nil {
		return nil, err
	}
	dateSet, dateStr := patchField[string](p, "date")
	fractionSet, fractionVal := patchField[float64](p, "fraction")
	noteSet, noteVal := patchField[string](p, "note")
	if err := p.Err(); err != nil {
		return nil, err
	}
	var dateVal pgtype.Date
	if dateSet && dateStr != nil {
		parsed, ok := parseDate(*dateStr)
		if !ok {
			return gen.UpdateCareDay400JSONResponse(badDate()), nil
		}
		dateVal = parsed
	} else {
		dateSet = false // the column is NOT NULL: a null date leaves it alone
	}
	if fractionVal == nil {
		fractionSet = false
	}

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetCareDayRow, error) {
			return d.Q.GetCareDay(ctx, dbgen.GetCareDayParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		p.Any(),
		func(ctx context.Context) error {
			_, err := d.Q.UpdateCareDay(ctx, dbgen.UpdateCareDayParams{
				FamilyID:    fam.FamilyID,
				ID:          req.Id,
				DateSet:     dateSet,
				DateVal:     dateVal,
				FractionSet: fractionSet,
				FractionVal: fractionVal,
				NoteSet:     noteSet,
				NoteVal:     noteVal,
			})
			return err
		},
	)
	if err != nil {
		if db.IsUniqueViolation(err) {
			return gen.UpdateCareDay409JSONResponse(duplicateCareDay()), nil
		}
		return nil, err
	}
	if !found {
		return gen.UpdateCareDay404JSONResponse(notFound()), nil
	}
	return gen.UpdateCareDay200JSONResponse(serCareDay(row)), nil
}

// DeleteCareDay implements DELETE /api/care-days/{id}.
func (d Deps) DeleteCareDay(ctx context.Context, req gen.DeleteCareDayRequestObject) (gen.DeleteCareDayResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteCareDay(ctx, dbgen.DeleteCareDayParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteCareDay404JSONResponse(notFound()), nil
	}
	return gen.DeleteCareDay200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// SetCareDayQuota implements PUT /api/care-days/quota: one's own number, or
// anyone's as a family admin. null clears it.
func (d Deps) SetCareDayQuota(ctx context.Context, req gen.SetCareDayQuotaRequestObject) (gen.SetCareDayQuotaResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetCareDayQuota")
	}
	userID, notMember, err := caretakerFor(ctx, d, fam, req.Body.UserId)
	if err != nil {
		return nil, err
	}
	if notMember {
		return gen.SetCareDayQuota403JSONResponse(notMemberErr()), nil
	}
	if userID != fam.UserID && fam.MemberRole != "admin" && fam.MemberRole != "owner" {
		return gen.SetCareDayQuota403JSONResponse(gen.Error{Error: "Only a family admin sets someone else's number", Code: "FORBIDDEN"}), nil
	}
	if req.Body.Days == nil {
		err = d.Q.ClearCareDayQuota(ctx, dbgen.ClearCareDayQuotaParams{FamilyID: fam.FamilyID, UserID: userID})
	} else {
		err = d.Q.SetCareDayQuota(ctx, dbgen.SetCareDayQuotaParams{FamilyID: fam.FamilyID, UserID: userID, Days: int32(*req.Body.Days)})
	}
	if err != nil {
		return nil, err
	}
	return gen.SetCareDayQuota200JSONResponse{Ok: gen.OkOkTrue}, nil
}
