package restore

import (
	"context"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

// querier is what reading the schema needs: a pool or a transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// tableInfo is one live table as a restore needs to know it.
type tableInfo struct {
	name string
	// columns are the ones a restore may write: every column but the
	// generated ones (users.display_name), in their declared order.
	columns []string
	has     map[string]bool
	refs    []foreignKey
}

// foreignKey is a single-column reference: column in this table points at
// table.refColumn. Every foreign key in the schema is single-column.
type foreignKey struct {
	column    string
	table     string
	refColumn string
}

type schema struct {
	tables map[string]*tableInfo
	// order is every table, parents before the tables that reference them.
	order []string
}

func readSchema(ctx context.Context, q querier) (*schema, error) {
	s := &schema{tables: map[string]*tableInfo{}}

	rows, err := q.Query(ctx, `
		SELECT "table_name", "column_name", "is_generated"
		FROM information_schema.columns
		WHERE "table_schema" = 'public'
		ORDER BY "table_name", "ordinal_position"`)
	if err != nil {
		return nil, fmt.Errorf("restore: read the columns: %w", err)
	}
	for rows.Next() {
		var table, column, generated string
		if err := rows.Scan(&table, &column, &generated); err != nil {
			rows.Close()
			return nil, fmt.Errorf("restore: read the columns: %w", err)
		}
		t := s.tables[table]
		if t == nil {
			t = &tableInfo{name: table, has: map[string]bool{}}
			s.tables[table] = t
		}
		t.has[column] = true
		if generated == "NEVER" {
			t.columns = append(t.columns, column)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("restore: read the columns: %w", err)
	}

	rows, err = q.Query(ctx, `
		SELECT cl."relname", a."attname", rf."relname", af."attname"
		FROM pg_constraint c
		JOIN pg_namespace n ON n."oid" = c."connamespace"
		JOIN pg_class cl ON cl."oid" = c."conrelid"
		JOIN pg_class rf ON rf."oid" = c."confrelid"
		JOIN pg_attribute a ON a."attrelid" = c."conrelid" AND a."attnum" = c."conkey"[1]
		JOIN pg_attribute af ON af."attrelid" = c."confrelid" AND af."attnum" = c."confkey"[1]
		WHERE c."contype" = 'f' AND n."nspname" = 'public'
		ORDER BY 1, 2`)
	if err != nil {
		return nil, fmt.Errorf("restore: read the foreign keys: %w", err)
	}
	for rows.Next() {
		var table string
		var fk foreignKey
		if err := rows.Scan(&table, &fk.column, &fk.table, &fk.refColumn); err != nil {
			rows.Close()
			return nil, fmt.Errorf("restore: read the foreign keys: %w", err)
		}
		if t := s.tables[table]; t != nil {
			t.refs = append(t.refs, fk)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("restore: read the foreign keys: %w", err)
	}

	s.order = parentsFirst(s.tables)
	return s, nil
}

// parentsFirst orders tables so every table comes after the tables it
// references (Kahn's algorithm, alphabetical among equals so the order is
// the same every run). A table referencing itself does not wait on itself.
// A cycle — there is none in this schema — would leave its tables at the
// end, where their inserts fail loudly rather than being skipped.
func parentsFirst(tables map[string]*tableInfo) []string {
	waiting := map[string]map[string]bool{}
	for name, t := range tables {
		waiting[name] = map[string]bool{}
		for _, fk := range t.refs {
			if fk.table != name && tables[fk.table] != nil {
				waiting[name][fk.table] = true
			}
		}
	}
	var order []string
	for len(waiting) > 0 {
		var ready []string
		for name, deps := range waiting {
			if len(deps) == 0 {
				ready = append(ready, name)
			}
		}
		if len(ready) == 0 {
			var rest []string
			for name := range waiting {
				rest = append(rest, name)
			}
			sort.Strings(rest)
			return append(order, rest...)
		}
		sort.Strings(ready)
		for _, name := range ready {
			delete(waiting, name)
			for _, deps := range waiting {
				delete(deps, name)
			}
		}
		order = append(order, ready...)
	}
	return order
}

// TableOrder is the order a restore loads tables in: parents first.
func TableOrder(ctx context.Context, q querier) ([]string, error) {
	s, err := readSchema(ctx, q)
	if err != nil {
		return nil, err
	}
	return s.order, nil
}
