package api

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// This file is the one home for the mechanical conversions between the three
// type systems every handler in this package sits between: the generated
// wire types (internal/api/gen, from openapi/pjokk.yaml), the generated
// query types (internal/db/gen, from sqlc), and plain Go.
//
// None of it is interesting on its own. It lives together because the
// alternative — which is what this package did until now — is the same four
// shapes hand-written at ~70 call sites, with the helpers that DO exist
// (enumStr in feeds.go, enumPtr in diapers.go, tsPtr in sleep.go) each
// discovered only by whoever happened to read that file first.
//
// # Converting between sqlc row types
//
// sqlc emits a distinct named struct PER QUERY, so the three queries that
// read a feed the same way (GetFeed, ListFeeds, ListFeedsPage) produce
// GetFeedRow, ListFeedsRow and ListFeedsPageRow — three names for one shape.
// This package used to bridge that with a serialiser taking fifteen
// positional parameters plus a thin unpacking wrapper per row type, which is
// how a fifteen-argument call ends up in a file nobody wants to edit.
//
// Structurally identical structs convert directly in Go, so each family now
// has ONE serialiser over the Get*Row spelling and every other call site
// writes dbgen.GetFeedRow(row). That is not merely shorter: the conversion
// is checked at compile time, so adding a column to one of the three queries
// and not the others stops the build — where the old field-by-field literal
// would have quietly dropped it, and a SELECT * over a shared view would
// have quietly over-fetched. staticcheck's S1016 says the same thing about
// the one place this package was already doing it by hand (ListContacts).

// ts is a Postgres timestamptz holding t. Every non-NULL timestamp a handler
// writes goes through here rather than through the four-field struct literal:
// `pgtype.Timestamptz{Time: t, Valid: true}` is easy to write correctly and
// just as easy to write with Valid omitted, which silently writes NULL.
func ts(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

// tsFrom is ts for an optional time: a valid timestamptz when t is non-nil,
// the zero (invalid, i.e. SQL NULL) value when it is nil.
//
// This is the shape every PATCH handler needs, because patchField reports a
// cleared field as a nil value — see patch.go. It replaces the
//
//	var timeParam pgtype.Timestamptz
//	if timeVal != nil {
//		timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
//	}
//
// block that used to precede every UpdateX's query call.
func tsFrom(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return ts(*t)
}

// tsPtr is tsFrom's inverse: a nullable Postgres timestamptz to a *time.Time,
// nil when SQL NULL (an active sleep session's endTime, say).
func tsPtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

// enumStr flattens an optional generated enum pointer (gen.CreateFeedContents,
// gen.CreateDiaperColor, …) to the plain *string the sqlc params take.
func enumStr[T ~string](v *T) *string {
	if v == nil {
		return nil
	}
	s := string(*v)
	return &s
}

// enumPtr is enumStr's inverse: a nullable text column to an optional
// generated enum pointer. The column's CHECK constraint already guarantees
// the value is one of the enum's members, so this never has to validate.
func enumPtr[T ~string](s *string) *T {
	if s == nil {
		return nil
	}
	v := T(*s)
	return &v
}
