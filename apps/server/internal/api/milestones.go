package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "milestones" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — `title` is required and NOT nullable (settable or
// omitted, never cleared to null). See other_logs.go's package doc comment
// for the shared createLog/updateLog/deleteLog engine and medicine.go for a
// fuller worked example.

func serMilestone(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, title string, notes *string) gen.MilestoneLog {
	return gen.MilestoneLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Title:         title,
		Notes:         notes,
	}
}

// ListMilestones implements GET /api/milestones. REF: "MilestoneLog[] newest first".
func (d Deps) ListMilestones(ctx context.Context, req gen.ListMilestonesRequestObject) (gen.ListMilestonesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListMilestones(ctx, dbgen.ListMilestonesParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.MilestoneLog, len(rows))
	for i, row := range rows {
		out[i] = serMilestone(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Title, row.Notes)
	}
	return gen.ListMilestones200JSONResponse(out), nil
}

// CreateMilestone implements POST /api/milestones. REF: "{babyId, time,
// title, notes?} → 201 / 404 unknown baby". Free in Go (see
// other_logs.go's doc comment).
func (d Deps) CreateMilestone(ctx context.Context, req gen.CreateMilestoneRequestObject) (gen.CreateMilestoneResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateMilestone")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateMilestone(ctx, dbgen.CreateMilestoneParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
				Title:       body.Title,
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetMilestoneRow, error) {
			return d.Q.GetMilestone(ctx, dbgen.GetMilestoneParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateMilestone404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreateMilestone201JSONResponse(serMilestone(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Title, row.Notes)), nil
}

// UpdateMilestone implements PATCH /api/milestones/{id}. REF: "partial
// (nullable clears) → MilestoneLog / 404".
func (d Deps) UpdateMilestone(ctx context.Context, req gen.UpdateMilestoneRequestObject) (gen.UpdateMilestoneResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateMilestone")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	titleSet, titleVal, err := patchField[string](fields, "title")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || titleSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetMilestoneRow, error) {
			return d.Q.GetMilestone(ctx, dbgen.GetMilestoneParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdateMilestone(ctx, dbgen.UpdateMilestoneParams{
				FamilyID: fam.FamilyID,
				ID:       req.Id,
				TimeSet:  timeSet,
				TimeVal:  timeParam,
				TitleSet: titleSet,
				TitleVal: titleVal,
				NotesSet: notesSet,
				NotesVal: notesVal,
			})
			return err
		},
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return gen.UpdateMilestone404JSONResponse(notFound()), nil
	}
	return gen.UpdateMilestone200JSONResponse(serMilestone(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Title, row.Notes)), nil
}

// DeleteMilestone implements DELETE /api/milestones/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteMilestone(ctx context.Context, req gen.DeleteMilestoneRequestObject) (gen.DeleteMilestoneResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteMilestone(ctx, dbgen.DeleteMilestoneParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteMilestone404JSONResponse(notFound()), nil
	}
	return gen.DeleteMilestone200JSONResponse{Ok: gen.OkOkTrue}, nil
}
