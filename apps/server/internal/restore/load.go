package restore

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// chunkRows bounds one INSERT: a table's rows go in as JSON arrays of at
// most this many, so a large table is several statements rather than one
// parameter the size of the table.
const chunkRows = 1000

// insertRows loads rows into t with Postgres doing the typing:
//
//	INSERT INTO t (cols) SELECT cols FROM json_populate_recordset(NULL::t, $1::json)
//
// cols are the table's writable columns that the snapshot actually
// carries. That is what makes schema drift harmless: a key the table no
// longer has is not in cols and is ignored; a column the snapshot lacks is
// not named either, so it takes its default rather than an explicit NULL
// (json_populate_recordset yields NULL for a missing key); and a generated
// column is never written. A NOT NULL column added since, with no default,
// fails naming the table. No conflict is tolerated.
func insertRows(ctx context.Context, tx pgx.Tx, t *tableInfo, rows []map[string]any) (int64, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	present := map[string]bool{}
	for _, r := range rows {
		for k := range r {
			present[k] = true
		}
	}
	var cols []string
	for _, c := range t.columns {
		if present[c] {
			cols = append(cols, pgx.Identifier{c}.Sanitize())
		}
	}
	if len(cols) == 0 {
		return 0, fmt.Errorf("restore: %s: the snapshot's rows share no column with the table", t.name)
	}
	name := pgx.Identifier{t.name}.Sanitize()
	list := strings.Join(cols, ", ")
	stmt := fmt.Sprintf(`INSERT INTO %s (%s) SELECT %s FROM json_populate_recordset(NULL::%s, $1::json)`,
		name, list, list, name)

	var total int64
	for start := 0; start < len(rows); start += chunkRows {
		end := min(start+chunkRows, len(rows))
		body, err := json.Marshal(rows[start:end])
		if err != nil {
			return total, fmt.Errorf("restore: %s: %w", t.name, err)
		}
		tag, err := tx.Exec(ctx, stmt, string(body))
		if err != nil {
			return total, fmt.Errorf("restore: %s: %w", t.name, err)
		}
		total += tag.RowsAffected()
	}
	return total, nil
}
