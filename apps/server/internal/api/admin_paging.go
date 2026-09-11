package api

import (
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
)

// Keyset paging for the operator console's lists — users, families and the
// audit trail (docs/superpowers/specs/2026-09-11-admin-user-support-design.md
// §2). Each list answers {items, nextCursor}, newest first.
//
// Keyset over (created_at, id) rather than an offset: the audit trail grows
// while an operator reads it, and an offset would shift every row a new one
// pushed down into the next page, serving it twice. The id breaks ties
// between rows written in the same microsecond, so the order is total.

// adminPageDefault is the page size when the request names none. The
// maximum (200) lives in the spec's limitQuery parameter, which request
// validation enforces before a handler runs.
const adminPageDefault = 50

// errBadCursor is a cursor that did not come from this server.
var errBadCursor = errors.New("api: malformed page cursor")

// adminCursor is a decoded position: the last row the previous page served.
type adminCursor struct {
	at time.Time
	id string
}

// encodeAdminCursor is opaque to the client on purpose: nothing may build
// one but the server, so its shape can change without a spec change.
func encodeAdminCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
}

// decodeAdminCursor reads a cursor from the query string; nil or "" is the
// first page.
func decodeAdminCursor(s *string) (*adminCursor, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(*s)
	if err != nil {
		return nil, errBadCursor
	}
	at, id, ok := strings.Cut(string(raw), "|")
	if !ok || id == "" {
		return nil, errBadCursor
	}
	t, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return nil, errBadCursor
	}
	return &adminCursor{at: t, id: id}, nil
}

// beforeAt and beforeID are the keyset bounds a query takes; both NULL on
// the first page, which collapses the bound to true.
func (c *adminCursor) beforeAt() pgtype.Timestamptz {
	if c == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: c.at, Valid: true}
}

func (c *adminCursor) beforeID() *string {
	if c == nil {
		return nil
	}
	return &c.id
}

func adminPageLimit(limit *int) int {
	if limit == nil {
		return adminPageDefault
	}
	return *limit
}

// pageOf trims a fetch of limit+1 rows to limit and, when the extra row was
// there, derives the next cursor from the last row kept. Fetching one more
// than a page is how a list knows whether a next page exists without a
// second query.
func pageOf[T any](rows []T, limit int, key func(T) (time.Time, string)) ([]T, *string) {
	if len(rows) <= limit {
		return rows, nil
	}
	rows = rows[:limit]
	at, id := key(rows[limit-1])
	next := encodeAdminCursor(at, id)
	return rows, &next
}

func badCursor() gen.Error {
	return gen.Error{Error: "That page cursor is not valid", Code: "VALIDATION"}
}
