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
