package jobs

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	pjokkdb "github.com/refsdal/pjokk/server/internal/db"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// orphanGracePeriod is the Go port of apps/api/src/jobs/plans.ts's
// purgeOrphanUsers 7-day cutoff: accounts created past the invite flow have
// no membership and can never create one, so they are swept after a week.
const orphanGracePeriod = 7 * 24 * time.Hour

// PurgeOrphanUsers deletes accounts that: are not a system admin (role IS
// NULL or role != "admin" — REF §A7; broader than the TypeScript
// predecessor's role="user"-or-null check, since this port never stamps a
// default "user" role at all), are not the tombstone account, were created
// more than orphanGracePeriod ago, and hold no family membership. Returns
// the number of accounts actually removed.
//
// A delete blocked by a foreign key (the account has left historical data
// behind — a log row, an audit entry, …) is swallowed, not fatal to the
// sweep: PurgeOrphanUsers only ever selects accounts with no *membership*
// row, but nothing here guarantees an orphan never accumulated FK-protected
// data some other way, and one unremovable account must not stop the rest
// from being purged. Any OTHER error is not swallowed — an unexpected
// failure here should surface, not silently under-purge.
func PurgeOrphanUsers(ctx context.Context, d Deps, now time.Time) (int, error) {
	cutoff := now.Add(-orphanGracePeriod)

	orphans, err := d.Q.ListOrphanUsers(ctx, dbgen.ListOrphanUsersParams{
		TombstoneID: pjokkdb.TombstoneID,
		Cutoff:      pgtype.Timestamptz{Time: cutoff, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("jobs: list orphan users: %w", err)
	}

	purged := 0
	for _, id := range orphans {
		if _, err := d.Q.DeleteOrphanUser(ctx, id); err != nil {
			if pjokkdb.IsForeignKeyViolation(err) {
				// FK-protected (historical data) — leave it alone.
				continue
			}
			return purged, fmt.Errorf("jobs: delete orphan user %s: %w", id, err)
		}
		purged++
		// Id, never the email: logs are outside our retention control, and an
		// address in them is personal data we cannot later erase.
		log.Printf("purge: removed orphan account %s", id)
	}
	return purged, nil
}
