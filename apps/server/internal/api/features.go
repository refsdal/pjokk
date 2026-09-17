package api

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// The per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): what the
// family tracks for one child, kept as baby.features (00033). The server
// stores the set and gates NOTHING on it — a write for an off kind is
// still accepted, from an API key or a queued offline save alike —
// because a switch is a preference about the UI, not a permission. The
// two jobs that read it hold rather than refuse (internal/jobs:
// reminders hold, closing alerts skip).

// SpecYAML is the embedded spec, for tests that read the document itself
// (TestAllFeaturesMatchTheSpec).
var SpecYAML = specYAML

// AllFeatures is every per-baby tracking switch, in the spec's order
// (openapi/pjokk.yaml `Feature`). The backfill in 00033_baby_features.sql
// and testrig.NewBaby both mean this list; TestAllFeaturesMatchTheSpec
// keeps it honest.
var AllFeatures = []string{
	"feeds", "pump", "sleep", "diapers", "medicine", "measurements",
	"milestones", "bath", "notes", "play", "daycare", "illness", "vaccines",
}

// featuresOf is the wire shape of a baby's column: never null, so a baby
// with nothing tracked reads as [] and the SPA's includes() has an array.
func featuresOf(stored []string) []gen.Feature {
	out := make([]gen.Feature, 0, len(stored))
	for _, f := range stored {
		out = append(out, gen.Feature(f))
	}
	return out
}

// normaliseFeatures drops duplicates and puts the set in the spec's order,
// so two saves of the same set store the same array whatever the client
// sent. Unknown keys cannot reach here: the request validator refuses them.
func normaliseFeatures(in []gen.Feature) []string {
	want := make(map[string]bool, len(in))
	for _, f := range in {
		want[string(f)] = true
	}
	out := make([]string, 0, len(want))
	for _, f := range AllFeatures {
		if want[f] {
			out = append(out, f)
		}
	}
	return out
}

// SetBabyFeatures implements PUT /api/babies/{id}/features, replaced
// whole. tierAdmin (a member sees the set and cannot change it) and never
// a kiosk device (deviceOperations is unchanged).
func (d Deps) SetBabyFeatures(ctx context.Context, req gen.SetBabyFeaturesRequestObject) (gen.SetBabyFeaturesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SetBabyFeatures")
	}
	baby, err := d.Q.SetBabyFeatures(ctx, dbgen.SetBabyFeaturesParams{
		FamilyID: fam.FamilyID,
		ID:       req.Id,
		Features: normaliseFeatures(req.Body.Features),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.SetBabyFeatures404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	return gen.SetBabyFeatures200JSONResponse(serBaby(baby)), nil
}
