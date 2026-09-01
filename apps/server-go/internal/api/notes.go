package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports the "notes" kind of apps/api/src/routes/other-logs.ts's
// makeLogRoutes factory — `content` is required and NOT nullable (settable
// or omitted, never cleared to null; see UpdateNote's OpenAPI description).
// See other_logs.go's package doc comment for the shared createLog/
// updateLog/deleteLog engine and medicine.go for a fuller worked example.

func serNote(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, content string, notes *string) gen.NoteLog {
	return gen.NoteLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Content:       content,
		Notes:         notes,
	}
}

// ListNotes implements GET /api/notes. REF: "NoteLog[] newest first".
func (d Deps) ListNotes(ctx context.Context, req gen.ListNotesRequestObject) (gen.ListNotesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListNotes(ctx, dbgen.ListNotesParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}
	out := make([]gen.NoteLog, len(rows))
	for i, row := range rows {
		out[i] = serNote(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Content, row.Notes)
	}
	return gen.ListNotes200JSONResponse(out), nil
}

// CreateNote implements POST /api/notes. REF: "{babyId, time, content,
// notes?} → 201 / 404 unknown baby". Free in Go (see other_logs.go's doc
// comment).
func (d Deps) CreateNote(ctx context.Context, req gen.CreateNoteRequestObject) (gen.CreateNoteResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateNote")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			return d.Q.CreateNote(ctx, dbgen.CreateNoteParams{
				FamilyID:    fam.FamilyID,
				BabyID:      body.BabyId,
				CaretakerID: fam.UserID,
				Time:        pgtype.Timestamptz{Time: body.Time, Valid: true},
				Content:     body.Content,
				Notes:       body.Notes,
			})
		},
		func(ctx context.Context, id string) (dbgen.GetNoteRow, error) {
			return d.Q.GetNote(ctx, dbgen.GetNoteParams{FamilyID: fam.FamilyID, ID: id})
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateNote404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreateNote201JSONResponse(serNote(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Content, row.Notes)), nil
}

// UpdateNote implements PATCH /api/notes/{id}. REF: "partial (nullable
// clears) → NoteLog / 404".
func (d Deps) UpdateNote(ctx context.Context, req gen.UpdateNoteRequestObject) (gen.UpdateNoteResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateNote")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	contentSet, contentVal, err := patchField[string](fields, "content")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || contentSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (dbgen.GetNoteRow, error) {
			return d.Q.GetNote(ctx, dbgen.GetNoteParams{FamilyID: fam.FamilyID, ID: req.Id})
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdateNote(ctx, dbgen.UpdateNoteParams{
				FamilyID:   fam.FamilyID,
				ID:         req.Id,
				TimeSet:    timeSet,
				TimeVal:    timeParam,
				ContentSet: contentSet,
				ContentVal: contentVal,
				NotesSet:   notesSet,
				NotesVal:   notesVal,
			})
			return err
		},
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return gen.UpdateNote404JSONResponse(notFound()), nil
	}
	return gen.UpdateNote200JSONResponse(serNote(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Content, row.Notes)), nil
}

// DeleteNote implements DELETE /api/notes/{id}. REF: "{ok:true} / 404".
func (d Deps) DeleteNote(ctx context.Context, req gen.DeleteNoteRequestObject) (gen.DeleteNoteResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteNote(ctx, dbgen.DeleteNoteParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteNote404JSONResponse(notFound()), nil
	}
	return gen.DeleteNote200JSONResponse{Ok: gen.OkOkTrue}, nil
}
