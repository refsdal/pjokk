package api

import (
	"context"
	"log"

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
// §A1 item 4). The failure is answered in the response body rather than
// returned to the strict-handler machinery: a database outage is a normal,
// expected 503, not a server bug that belongs in the 500 path.
//
// The body carries a FIXED string, never err.Error(). /readyz is tierPublic
// — an orchestrator must be able to probe it without a session — and a raw
// pgx error names the host, port, database and sometimes the user of the
// connection that failed. That is the same reasoning responseErrorHandler
// applies to every other unexpected failure: log the detail, return the
// envelope. The `error` field itself stays because the spec requires it.
func (d Deps) Readyz(ctx context.Context, _ gen.ReadyzRequestObject) (gen.ReadyzResponseObject, error) {
	var one int
	if err := d.Pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		log.Printf("api: readyz: database unreachable: %v", err)
		return gen.Readyz503JSONResponse{Ok: gen.False, Error: "database unreachable"}, nil
	}
	return gen.Readyz200JSONResponse{Ok: gen.Readyz200JSONResponseBodyOkTrue}, nil
}
