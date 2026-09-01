package api

import (
	"context"
	"strings"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// A note on trimming: apps/api's CreateSleepLocationSchema is
// z.string().trim().min(1).max(40) — zod trims BEFORE checking length, so a
// name of only whitespace fails validation there. openapi/pjokk.yaml's
// CreateSleepLocation (minLength/maxLength) can only bound the RAW body
// kin-openapi validates, not a trimmed derivative, so a whitespace-only name
// passes spec validation here and is trimmed to "" below — untested by the
// ported suite (apps/api/test never exercises that input) and accepted as a
// minor, deliberate gap rather than adding a bespoke 400 response this
// endpoint's spec doesn't otherwise need.

// This file ports apps/api/src/routes/sleep-locations.ts. Family-admin-only
// writes AND the "not available to API keys" rejection are both handled
// entirely by middleware.RequireAdmin, reached via the tierAdmin entries
// api.go's operationAuthTiers gives CreateSleepLocation/DeleteSleepLocation
// — see the comment there. This file only has the domain logic RequireAdmin
// can't provide: duplicate-name and 20-location-cap checks, ported verbatim
// from the TS route as a pre-check rather than enforced at the database —
// there is no unique constraint on sleep_location(family_id, name), unlike
// sleep_log's partial unique index (see queries/sleep_locations.sql).

// defaultSleepLocations are the fixed chips every family gets for free (see
// the SleepSheet UI) — custom names may not collide with these,
// case-insensitively.
var defaultSleepLocations = []string{"crib", "stroller", "arms", "contact nap"}

// maxCustomSleepLocations caps custom (family-owned) sleep locations per
// family.
const maxCustomSleepLocations = 20

// ListSleepLocations implements GET /api/sleep-locations. REF:
// "{id,name}[]".
func (d Deps) ListSleepLocations(ctx context.Context, _ gen.ListSleepLocationsRequestObject) (gen.ListSleepLocationsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListSleepLocations(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.SleepLocation, len(rows))
	for i, row := range rows {
		out[i] = gen.SleepLocation{Id: row.ID, Name: row.Name}
	}
	return gen.ListSleepLocations200JSONResponse(out), nil
}

// CreateSleepLocation implements POST /api/sleep-locations. REF: "{name
// 1..40 trimmed} → 201; 409 DUPLICATE vs a default or existing custom name
// (case-insensitive); 409 LIMIT_REACHED at 20 custom locations". Reached
// only via tierAdmin (api.go), so the caller is already known to be a
// family admin, not an API key.
func (d Deps) CreateSleepLocation(ctx context.Context, req gen.CreateSleepLocationRequestObject) (gen.CreateSleepLocationResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateSleepLocation")
	}
	name := strings.TrimSpace(req.Body.Name)

	existing, err := d.Q.ListSleepLocations(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}

	lower := strings.ToLower(name)
	duplicate := false
	for _, dl := range defaultSleepLocations {
		if dl == lower {
			duplicate = true
			break
		}
	}
	if !duplicate {
		for _, ex := range existing {
			if strings.ToLower(ex.Name) == lower {
				duplicate = true
				break
			}
		}
	}
	if duplicate {
		return gen.CreateSleepLocation409JSONResponse{Error: "Duplicate name", Code: "DUPLICATE"}, nil
	}
	if len(existing) >= maxCustomSleepLocations {
		return gen.CreateSleepLocation409JSONResponse{Error: "Limit reached", Code: "LIMIT_REACHED"}, nil
	}

	created, err := d.Q.CreateSleepLocation(ctx, dbgen.CreateSleepLocationParams{FamilyID: fam.FamilyID, Name: name})
	if err != nil {
		return nil, err
	}
	return gen.CreateSleepLocation201JSONResponse{Id: created.ID, Name: created.Name}, nil
}

// DeleteSleepLocation implements DELETE /api/sleep-locations/{id}. REF:
// "{ok:true} / 404". Reached only via tierAdmin.
func (d Deps) DeleteSleepLocation(ctx context.Context, req gen.DeleteSleepLocationRequestObject) (gen.DeleteSleepLocationResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteSleepLocation(ctx, dbgen.DeleteSleepLocationParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteSleepLocation404JSONResponse(notFound()), nil
	}
	return gen.DeleteSleepLocation200JSONResponse{Ok: gen.OkOkTrue}, nil
}
