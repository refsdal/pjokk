package api

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// What the logs cannot know about a child (issue #109): four free-text
// lines kept beside the baby for the "About <name>" sheet a barnehage asks
// for before tilvenning. The sheet itself is built in the browser
// (lib/about-me.ts) from the ordinary reads; this is only where the words
// live. Any member may write them — they are the family's description of
// its child, like a note — and a key may not reach a device
// (deviceOperations is unchanged).

// blankToNil stores nothing for a line that is empty once trimmed, so
// "cleared" and "never written" are one state.
func blankToNil(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		return nil
	}
	return &t
}

// GetBabyAbout implements GET /api/babies/{id}/about.
func (d Deps) GetBabyAbout(ctx context.Context, req gen.GetBabyAboutRequestObject) (gen.GetBabyAboutResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	known, err := babyExists(ctx, d, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.GetBabyAbout404JSONResponse(notFound()), nil
	}
	row, err := d.Q.GetBabyAbout(ctx, dbgen.GetBabyAboutParams{FamilyID: fam.FamilyID, BabyID: req.Id})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// ErrNoRows leaves the zero row: four nils, which is the answer.
	return gen.GetBabyAbout200JSONResponse{Comfort: row.Comfort, FallsAsleep: row.FallsAsleep, Diet: row.Diet, Other: row.Other}, nil
}

// PutBabyAbout implements PUT /api/babies/{id}/about.
func (d Deps) PutBabyAbout(ctx context.Context, req gen.PutBabyAboutRequestObject) (gen.PutBabyAboutResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("PutBabyAbout")
	}
	known, err := babyExists(ctx, d, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.PutBabyAbout404JSONResponse(notFound()), nil
	}
	out := gen.BabyAbout{
		Comfort:     blankToNil(req.Body.Comfort),
		FallsAsleep: blankToNil(req.Body.FallsAsleep),
		Diet:        blankToNil(req.Body.Diet),
		Other:       blankToNil(req.Body.Other),
	}
	if err := d.Q.PutBabyAbout(ctx, dbgen.PutBabyAboutParams{
		BabyID: req.Id, FamilyID: fam.FamilyID,
		Comfort: out.Comfort, FallsAsleep: out.FallsAsleep, Diet: out.Diet, Other: out.Other,
	}); err != nil {
		return nil, err
	}
	return gen.PutBabyAbout200JSONResponse(out), nil
}

// SetUsualNap implements PUT /api/babies/{id}/usual-nap (issue #112): the
// family's own nap anchor, minutes after local midnight, or null. It is a
// wall-clock time — "she naps at half past eleven" — so the server stores
// the number and compares it with nothing; the device has the clock.
func (d Deps) SetUsualNap(ctx context.Context, req gen.SetUsualNapRequestObject) (gen.SetUsualNapResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetUsualNap")
	}
	known, err := babyExists(ctx, d, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	if !known {
		return gen.SetUsualNap404JSONResponse(notFound()), nil
	}
	if err := d.Q.SetUsualNapMinute(ctx, dbgen.SetUsualNapMinuteParams{
		BabyID: req.Id, FamilyID: fam.FamilyID, Minute: int32Ptr(req.Body.Minute),
	}); err != nil {
		return nil, err
	}
	return gen.SetUsualNap200JSONResponse{Ok: gen.OkOkTrue}, nil
}
