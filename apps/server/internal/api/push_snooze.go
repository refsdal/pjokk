package api

// POST /api/push/snooze (DECISIONS 2026-09-11): the Snooze button on a
// reminder notification. The service worker makes the call in the
// background, with no app window and no reliable session, so the signed
// token the button carries is the credential (internal/push/snooze.go) and
// the route is tierPublic.

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
)

func invalidSnooze() gen.Error {
	return gen.Error{Error: "That snooze button is no longer valid", Code: "INVALID_TOKEN"}
}

func (d Deps) SnoozePush(ctx context.Context, req gen.SnoozePushRequestObject) (gen.SnoozePushResponseObject, error) {
	c, err := push.VerifySnooze(d.SnoozeKey, req.Params.T, d.Now())
	if err != nil {
		return gen.SnoozePush400JSONResponse(invalidSnooze()), nil
	}
	var occurrence pgtype.Timestamptz
	if c.Occurrence != nil {
		occurrence = ts(*c.Occurrence)
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)
	// A second tap (or the same notification on another device) replaces
	// the first snooze rather than adding one.
	if err := qtx.DeletePushSnoozesFor(ctx, dbgen.DeletePushSnoozesForParams{
		FamilyID: c.FamilyID, UserID: c.UserID, Source: c.Source, SourceID: c.ID, OccurrenceStart: occurrence,
	}); err != nil {
		return nil, err
	}
	if err := qtx.CreatePushSnooze(ctx, dbgen.CreatePushSnoozeParams{
		FamilyID:        c.FamilyID,
		UserID:          c.UserID,
		Source:          c.Source,
		SourceID:        c.ID,
		OccurrenceStart: occurrence,
		SentAt:          ts(c.SentAt),
		DueAt:           ts(c.SentAt.Add(push.SnoozeFor)),
	}); err != nil {
		// The person or the family is gone since the notification went out.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return gen.SnoozePush400JSONResponse(invalidSnooze()), nil
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return gen.SnoozePush200JSONResponse{Ok: gen.OkOkTrue}, nil
}
