package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Reminders (issue #45): a small per-user list replacing push_pref's one
// feed-gap integer. GET/POST/DELETE only — a reminder is cheap enough to
// recreate that an edit endpoint would buy a PATCH tri-state for nothing.
// The due logic is internal/jobs/reminders.go's; this file owns the shape
// rules the spec's enums cannot express on their own (see validateReminder)
// and the personal scoping: every query takes the caller's user id, so one
// caretaker can neither see nor delete another's.

func serReminder(r dbgen.Reminder) gen.Reminder {
	return gen.Reminder{
		Id:          r.ID,
		BabyId:      r.BabyID,
		Kind:        gen.ReminderKind(r.Kind),
		Mode:        gen.ReminderMode(r.Mode),
		IntervalMin: r.IntervalMin,
		AtMinute:    r.AtMinute,
		Days:        r.DaysMask,
		Tz:          r.Tz,
		QuietStart:  r.QuietStart,
		QuietEnd:    r.QuietEnd,
		Label:       r.Label,
		LastFiredAt: tsPtr(r.LastFiredAt),
	}
}

// validateReminder is the cross-field half of the contract: the spec bounds
// each field on its own, but not "since_last needs an interval", "custom is
// at_time and has a label", "quiet hours come in pairs" or "the timezone
// exists". Returns the message for a 400, or "".
func validateReminder(b *gen.CreateReminder) string {
	switch b.Mode {
	case gen.CreateReminderModeSinceLast:
		if b.IntervalMin == nil {
			return "since_last needs intervalMin"
		}
	case gen.CreateReminderModeAtTime:
		if b.AtMinute == nil {
			return "at_time needs atMinute"
		}
	}
	if b.Kind == gen.CreateReminderKindCustom {
		if b.Mode != gen.CreateReminderModeAtTime {
			return "a custom reminder is always at_time"
		}
		if b.Label == nil || strings.TrimSpace(*b.Label) == "" {
			return "a custom reminder needs a label"
		}
	}
	if (b.QuietStart == nil) != (b.QuietEnd == nil) {
		return "quiet hours need both quietStart and quietEnd"
	}
	if _, err := time.LoadLocation(b.Tz); err != nil || b.Tz == "" {
		return "unknown timezone"
	}
	return ""
}

// ListReminders implements GET /api/reminders.
func (d Deps) ListReminders(ctx context.Context, _ gen.ListRemindersRequestObject) (gen.ListRemindersResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListReminders(ctx, dbgen.ListRemindersParams{UserID: fam.UserID, FamilyID: fam.FamilyID})
	if err != nil {
		return nil, err
	}
	out := make([]gen.Reminder, len(rows))
	for i, r := range rows {
		out[i] = serReminder(r)
	}
	return gen.ListReminders200JSONResponse(out), nil
}

// CreateReminder implements POST /api/reminders.
func (d Deps) CreateReminder(ctx context.Context, req gen.CreateReminderRequestObject) (gen.CreateReminderResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateReminder")
	}
	body := req.Body
	if msg := validateReminder(body); msg != "" {
		return gen.CreateReminder400JSONResponse{Error: msg, Code: "VALIDATION"}, nil
	}
	if body.BabyId != nil {
		if _, err := d.Q.GetBaby(ctx, dbgen.GetBabyParams{FamilyID: fam.FamilyID, ID: *body.BabyId}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return gen.CreateReminder404JSONResponse(unknownBabyErr()), nil
			}
			return nil, err
		}
	}
	days := int32(127)
	if body.Days != nil {
		days = *body.Days
	}
	var label *string
	if body.Label != nil {
		if v := strings.TrimSpace(*body.Label); v != "" {
			label = &v
		}
	}
	// Only the mode's own field is stored; the other stays NULL so the row
	// never carries a stale value from a client that sent both.
	var interval, atMinute *int32
	if body.Mode == gen.CreateReminderModeSinceLast {
		interval = body.IntervalMin
	} else {
		atMinute = body.AtMinute
	}

	row, err := d.Q.CreateReminder(ctx, dbgen.CreateReminderParams{
		FamilyID:    fam.FamilyID,
		UserID:      fam.UserID,
		BabyID:      body.BabyId,
		Kind:        string(body.Kind),
		Mode:        string(body.Mode),
		IntervalMin: interval,
		AtMinute:    atMinute,
		DaysMask:    days,
		Tz:          body.Tz,
		QuietStart:  body.QuietStart,
		QuietEnd:    body.QuietEnd,
		Label:       label,
	})
	if err != nil {
		return nil, err
	}
	return gen.CreateReminder201JSONResponse(serReminder(row)), nil
}

// DeleteReminder implements DELETE /api/reminders/{id}.
func (d Deps) DeleteReminder(ctx context.Context, req gen.DeleteReminderRequestObject) (gen.DeleteReminderResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteReminder(ctx, dbgen.DeleteReminderParams{ID: req.Id, UserID: fam.UserID, FamilyID: fam.FamilyID})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteReminder404JSONResponse(notFound()), nil
	}
	return gen.DeleteReminder200JSONResponse{Ok: gen.OkOkTrue}, nil
}
