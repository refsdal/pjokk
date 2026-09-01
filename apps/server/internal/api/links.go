package api

import (
	"context"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file is the tenancy backstop shared by calendar.go and
// contacts.go: both attach caller-supplied ids to a family-scoped row
// through a join table (calendar_event_baby/calendar_assignee,
// contact_baby) that carries no family_id of its own, so the ids
// themselves have to be checked against the caller's family before they
// are ever inserted — ports apps/api/src/routes/calendar.ts's refsValid
// and contacts.ts's babiesValid as one function.

// uniqueStrings returns ids with duplicates removed, first occurrence
// wins, order preserved. Mirrors apps/api's `[...new Set(ids)]` — the
// dedupe every caller here applies before both validating and inserting,
// so a client that sends the same id twice hits neither the tenancy check
// nor the join table's pair-PK twice.
func uniqueStrings(ids []string) []string {
	if len(ids) == 0 {
		return ids
	}
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// derefStrSlice returns *ids, or nil when ids itself is nil — the
// generated Create/Update body types carry babyIds/assigneeUserIds as
// *[]string (optional array), and every caller here wants a plain []string
// to range over regardless of whether the field was present.
func derefStrSlice(ids *[]string) []string {
	if ids == nil {
		return nil
	}
	return *ids
}

// refsValid reports whether every id in babyIDs belongs to a baby in
// familyID and every id in userIDs belongs to a member of familyID.
// Either slice may be empty — an empty slice is trivially valid and skips
// its query entirely, same as apps/api's refsValid/babiesValid only
// bothering to check a non-empty array. Callers pass already-deduped
// slices (see uniqueStrings) so the length comparison below is exact.
func refsValid(ctx context.Context, d Deps, familyID string, babyIDs, userIDs []string) (bool, error) {
	if len(babyIDs) > 0 {
		valid, err := d.Q.ValidBabyIDs(ctx, dbgen.ValidBabyIDsParams{FamilyID: familyID, Ids: babyIDs})
		if err != nil {
			return false, err
		}
		if len(valid) != len(babyIDs) {
			return false, nil
		}
	}
	if len(userIDs) > 0 {
		valid, err := d.Q.ValidFamilyMemberUserIDs(ctx, dbgen.ValidFamilyMemberUserIDsParams{OrganizationID: familyID, Ids: userIDs})
		if err != nil {
			return false, err
		}
		if len(valid) != len(userIDs) {
			return false, nil
		}
	}
	return true, nil
}
