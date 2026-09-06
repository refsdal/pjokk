package jobs_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Help requests stop being shown two hours after creation (a read-side
// filter, internal/api/summary.go); this sweep is only housekeeping so the
// table does not grow forever. Seven days, matching the orphan-account
// grace period.
func TestPurgeHelpRequestsRemovesWeekOldRows(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, _ := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	kariID := a.SignUp("Kari", "kari@example.com")

	now := time.Now()
	mk := func(age time.Duration) string {
		id, err := a.Deps.Q.CreateHelpRequest(ctx, dbgen.CreateHelpRequestParams{
			FamilyID: familyID, FromUserID: adminID, ToUserID: kariID, Message: "",
			CreatedAt: pgtype.Timestamptz{Time: now.Add(-age), Valid: true},
		})
		if err != nil {
			t.Fatalf("CreateHelpRequest: %v", err)
		}
		return id
	}
	old := mk(8 * 24 * time.Hour)
	recent := mk(24 * time.Hour)

	purged, err := jobs.PurgeHelpRequests(ctx, depsFor(a), now)
	if err != nil {
		t.Fatalf("PurgeHelpRequests: %v", err)
	}
	if purged != 1 {
		t.Errorf("purged = %d, want 1", purged)
	}
	if _, err := a.Deps.Q.GetHelpRequest(ctx, dbgen.GetHelpRequestParams{FamilyID: familyID, ID: old}); !errors.Is(err, pgx.ErrNoRows) {
		t.Errorf("week-old request survived (err = %v)", err)
	}
	if _, err := a.Deps.Q.GetHelpRequest(ctx, dbgen.GetHelpRequestParams{FamilyID: familyID, ID: recent}); err != nil {
		t.Errorf("day-old request was purged: %v", err)
	}
}
