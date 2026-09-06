package jobs

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// helpRequestRetention is how long a help_request row is kept. Home stops
// showing a request two hours after creation (internal/api/summary.go's
// read-side window), so this is housekeeping, not behaviour: it keeps the
// table from growing forever. Seven days, the same grace period as
// PurgeOrphanUsers.
const helpRequestRetention = 7 * 24 * time.Hour

// PurgeHelpRequests deletes help requests older than helpRequestRetention
// and returns how many went.
func PurgeHelpRequests(ctx context.Context, d Deps, now time.Time) (int, error) {
	n, err := d.Q.PurgeOldHelpRequests(ctx, pgtype.Timestamptz{Time: now.Add(-helpRequestRetention), Valid: true})
	if err != nil {
		return 0, fmt.Errorf("jobs: purge help requests: %w", err)
	}
	return int(n), nil
}
