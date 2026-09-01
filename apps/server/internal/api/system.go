package api

import (
	"context"

	"github.com/refsdal/pjokk/server/internal/api/gen"
)

var _ gen.StrictServerInterface = Deps{}

// Healthz is a pure liveness probe: it touches nothing, not even the
// database pool, so a Postgres outage never turns "the process is up" into
// a false negative. Deps.Pool is intentionally unread here (REF §A1 item 3).
func (d Deps) Healthz(_ context.Context, _ gen.HealthzRequestObject) (gen.HealthzResponseObject, error) {
	return gen.Healthz200JSONResponse{Ok: gen.Healthz200JSONResponseBodyOkTrue}, nil
}

// Readyz runs `SELECT 1` against the pool and reports 503 on failure (REF
// §A1 item 4). Errors are reported in the response body rather than
// returned to the strict-handler machinery: a database outage is a normal,
// expected 503, not a server bug that belongs in the 500 path.
func (d Deps) Readyz(ctx context.Context, _ gen.ReadyzRequestObject) (gen.ReadyzResponseObject, error) {
	var one int
	if err := d.Pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return gen.Readyz503JSONResponse{Ok: gen.False, Error: err.Error()}, nil
	}
	return gen.Readyz200JSONResponse{Ok: gen.Readyz200JSONResponseBodyOkTrue}, nil
}
