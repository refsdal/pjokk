package api

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/vaccines.ts's JSON route tree — the
// vaccine log itself (list/create/update/delete) and its dismissals
// (list/create/delete). Both are free: CLAUDE.md's entitlement helper
// always returns true on this port, and unlike other-logs.go/play.go this
// was never gated on the TS side either — only ATTACHING a document is
// (internal/api/files.go's DocumentUploadsEnabled = false makes that a
// moot point today regardless). See other_logs.go's package doc comment
// for the shared createLog/updateLog/deleteLog engine CreateVaccine and
// UpdateVaccine below use, and feeds.go's package doc comment for the PATCH
// tri-state (patchField/rawBodyFields) pattern.
//
// # Divergence: hydrated documents
//
// Unlike every other other_logs-shaped kind, a VaccineLog carries a nested
// `documents` array (queries/vaccines.sql's ListVaccineDocumentsForLogs/
// ListVaccineDocumentsForLog — see that file's header for why hydration is
// a second query rather than a join). serVaccine below always takes that
// slice as a parameter rather than fetching it itself, so ListVaccines can
// batch one hydration query across every row on the page instead of running
// N+1 — the same shape apps/api/src/db/scoped.ts's hydrateVaccines takes.
//
// # Divergence: dismissals are a second, sibling resource
//
// ListVaccineDismissals/CreateVaccineDismissal/DeleteVaccineDismissal are a
// separate table (vaccine_dismissal) with its own idempotent-create
// semantics (REF: "idempotent on unique — returns existing row"), not a
// field on VaccineLog. api.go's operationAuthTiers lists all seven
// operations (four vaccine, three dismissal) as tierFamily; nothing here
// needs the ordering care api.go's doc comment warns Hono's tree needed —
// Go's net/http.ServeMux (and kin-openapi's own request matching) already
// prefer the literal "/api/vaccines/dismissals" path over the
// "/api/vaccines/{id}" wildcard regardless of registration order, so
// dismissals never risk being swallowed as an id (see vaccines_test.go's
// TestVaccineDismissalsPathIsNotCapturedAsAnId for the regression this
// would otherwise be).

// serVaccineDocuments converts one batch of hydration rows (any of the
// three structurally-identical Row shapes ListVaccineDocumentsForLogs/
// ListVaccineDocumentsForLog produce) into the wire shape, always
// non-nil — VaccineLogSchema's `documents` is a required array, never
// omitted or null, so a vaccine with no attachments still serializes as
// `"documents":[]`.
func serVaccineDocuments(rows []dbgen.ListVaccineDocumentsForLogRow) []gen.VaccineDocument {
	out := make([]gen.VaccineDocument, len(rows))
	for i, r := range rows {
		out[i] = gen.VaccineDocument{
			Id:          r.ID,
			Filename:    r.Filename,
			ContentType: r.ContentType,
			Size:        int(r.Size),
			Url:         "/api/files/" + r.ID,
		}
	}
	return out
}

func doseNumberPtr(v *int32) *int {
	if v == nil {
		return nil
	}
	i := int(*v)
	return &i
}

func serVaccineRow(id, babyID, caretakerID, caretakerName string, t pgtype.Timestamptz, name string, doseNumber *int32, scheduleSlot, notes *string, docs []dbgen.ListVaccineDocumentsForLogRow) gen.VaccineLog {
	return gen.VaccineLog{
		Id:            id,
		BabyId:        babyID,
		CaretakerId:   caretakerID,
		CaretakerName: caretakerName,
		Time:          t.Time,
		Name:          name,
		DoseNumber:    doseNumberPtr(doseNumber),
		ScheduleSlot:  scheduleSlot,
		Notes:         notes,
		Documents:     serVaccineDocuments(docs),
	}
}

func serVaccine(row dbgen.GetVaccineRow, docs []dbgen.ListVaccineDocumentsForLogRow) gen.VaccineLog {
	return serVaccineRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Name, row.DoseNumber, row.ScheduleSlot, row.Notes, docs)
}

// getVaccineWithDocuments re-reads one vaccine log plus its documents — the
// re-read every createLog/updateLog closure below needs after a write.
func (d Deps) getVaccineWithDocuments(ctx context.Context, familyID, id string) (gen.VaccineLog, error) {
	row, err := d.Q.GetVaccine(ctx, dbgen.GetVaccineParams{FamilyID: familyID, ID: id})
	if err != nil {
		return gen.VaccineLog{}, err
	}
	docs, err := d.Q.ListVaccineDocumentsForLog(ctx, dbgen.ListVaccineDocumentsForLogParams{FamilyID: familyID, VaccineLogID: id})
	if err != nil {
		return gen.VaccineLog{}, err
	}
	return serVaccine(row, docs), nil
}

// ListVaccines implements GET /api/vaccines. REF: "VaccineLog[] (documents
// as {…, url: "/api/files/{docId}"})", newest first.
func (d Deps) ListVaccines(ctx context.Context, req gen.ListVaccinesRequestObject) (gen.ListVaccinesResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListVaccines(ctx, dbgen.ListVaccinesParams{
		FamilyID: fam.FamilyID,
		BabyID:   req.Params.BabyId,
		Lim:      listLimit(req.Params.Limit),
	})
	if err != nil {
		return nil, err
	}

	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	docRows, err := d.Q.ListVaccineDocumentsForLogs(ctx, dbgen.ListVaccineDocumentsForLogsParams{FamilyID: fam.FamilyID, VaccineLogIds: ids})
	if err != nil {
		return nil, err
	}
	byLog := make(map[string][]dbgen.ListVaccineDocumentsForLogRow, len(rows))
	for _, dr := range docRows {
		byLog[dr.VaccineLogID] = append(byLog[dr.VaccineLogID], dbgen.ListVaccineDocumentsForLogRow{
			ID: dr.ID, Filename: dr.Filename, ContentType: dr.ContentType, Size: dr.Size,
		})
	}

	out := make([]gen.VaccineLog, len(rows))
	for i, row := range rows {
		out[i] = serVaccineRow(row.ID, row.BabyID, row.CaretakerID, row.CaretakerName, row.Time, row.Name, row.DoseNumber, row.ScheduleSlot, row.Notes, byLog[row.ID])
	}
	return gen.ListVaccines200JSONResponse(out), nil
}

// CreateVaccine implements POST /api/vaccines. REF: "{babyId, time, name,
// doseNumber?, scheduleSlot?, notes?} → 201 / 404 unknown baby". Free — no
// plan gate on the log itself (see this file's doc comment).
func (d Deps) CreateVaccine(ctx context.Context, req gen.CreateVaccineRequestObject) (gen.CreateVaccineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateVaccine")
	}
	body := req.Body

	row, unknownBaby, err := createLog(ctx, d, fam.FamilyID, body.BabyId,
		func(ctx context.Context) (string, error) {
			var doseNumber *int32
			if body.DoseNumber != nil {
				v := int32(*body.DoseNumber)
				doseNumber = &v
			}
			return d.Q.CreateVaccine(ctx, dbgen.CreateVaccineParams{
				FamilyID:     fam.FamilyID,
				BabyID:       body.BabyId,
				CaretakerID:  fam.UserID,
				Time:         pgtype.Timestamptz{Time: body.Time, Valid: true},
				Name:         body.Name,
				DoseNumber:   doseNumber,
				ScheduleSlot: body.ScheduleSlot,
				Notes:        body.Notes,
			})
		},
		func(ctx context.Context, id string) (gen.VaccineLog, error) {
			return d.getVaccineWithDocuments(ctx, fam.FamilyID, id)
		},
	)
	if err != nil {
		return nil, err
	}
	if unknownBaby {
		return gen.CreateVaccine404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}
	return gen.CreateVaccine201JSONResponse(row), nil
}

// UpdateVaccine implements PATCH /api/vaccines/{id}. REF: "partial
// (nullable clears) → VaccineLog / 404". `time`/`name` are settable but not
// nullable; `doseNumber`/`scheduleSlot`/`notes` may be sent as `null` to
// clear.
func (d Deps) UpdateVaccine(ctx context.Context, req gen.UpdateVaccineRequestObject) (gen.UpdateVaccineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateVaccine")
	}

	timeSet, timeVal, err := patchField[time.Time](fields, "time")
	if err != nil {
		return nil, err
	}
	nameSet, nameVal, err := patchField[string](fields, "name")
	if err != nil {
		return nil, err
	}
	doseNumberSet, doseNumberVal, err := patchField[int32](fields, "doseNumber")
	if err != nil {
		return nil, err
	}
	scheduleSlotSet, scheduleSlotVal, err := patchField[string](fields, "scheduleSlot")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	anySet := timeSet || nameSet || doseNumberSet || scheduleSlotSet || notesSet

	row, found, err := updateLog(ctx,
		func(ctx context.Context) (gen.VaccineLog, error) {
			return d.getVaccineWithDocuments(ctx, fam.FamilyID, req.Id)
		},
		anySet,
		func(ctx context.Context) error {
			var timeParam pgtype.Timestamptz
			if timeVal != nil {
				timeParam = pgtype.Timestamptz{Time: *timeVal, Valid: true}
			}
			_, err := d.Q.UpdateVaccine(ctx, dbgen.UpdateVaccineParams{
				FamilyID:        fam.FamilyID,
				ID:              req.Id,
				TimeSet:         timeSet,
				TimeVal:         timeParam,
				NameSet:         nameSet,
				NameVal:         nameVal,
				DoseNumberSet:   doseNumberSet,
				DoseNumberVal:   doseNumberVal,
				ScheduleSlotSet: scheduleSlotSet,
				ScheduleSlotVal: scheduleSlotVal,
				NotesSet:        notesSet,
				NotesVal:        notesVal,
			})
			return err
		},
	)
	if err != nil {
		return nil, err
	}
	if !found {
		return gen.UpdateVaccine404JSONResponse(notFound()), nil
	}
	return gen.UpdateVaccine200JSONResponse(row), nil
}

// DeleteVaccine implements DELETE /api/vaccines/{id}. REF: "{ok:true} / 404;
// also deletes stored objects for attached docs". The DB row (and its
// vaccine_document children, via ON DELETE CASCADE) cascades away with
// DeleteVaccine; the objects behind those documents do not, so the object
// keys are read BEFORE the delete and removed from Storage AFTER it — a
// failure there leaks an orphan object rather than leaving a document row
// pointing at nothing (mirrors apps/api's scoped.ts deleteVaccine +
// routes/vaccines.ts's remove handler).
func (d Deps) DeleteVaccine(ctx context.Context, req gen.DeleteVaccineRequestObject) (gen.DeleteVaccineResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	keys, err := d.Q.VaccineObjectKeysForLog(ctx, dbgen.VaccineObjectKeysForLogParams{FamilyID: fam.FamilyID, VaccineLogID: req.Id})
	if err != nil {
		return nil, err
	}

	ok, err := deleteLog(ctx, func(ctx context.Context) (int64, error) {
		return d.Q.DeleteVaccine(ctx, dbgen.DeleteVaccineParams{FamilyID: fam.FamilyID, ID: req.Id})
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.DeleteVaccine404JSONResponse(notFound()), nil
	}

	if len(keys) > 0 {
		if err := d.Storage.Delete(ctx, keys...); err != nil {
			return nil, err
		}
	}
	return gen.DeleteVaccine200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// --- vaccine dismissals ---

func serVaccineDismissal(id, babyID, slotKey string) gen.VaccineDismissal {
	return gen.VaccineDismissal{Id: id, BabyId: babyID, SlotKey: slotKey}
}

// ListVaccineDismissals implements GET /api/vaccines/dismissals. REF:
// "{id, babyId, slotKey}[]". Free, like the log itself.
func (d Deps) ListVaccineDismissals(ctx context.Context, req gen.ListVaccineDismissalsRequestObject) (gen.ListVaccineDismissalsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListVaccineDismissals(ctx, dbgen.ListVaccineDismissalsParams{FamilyID: fam.FamilyID, BabyID: req.Params.BabyId})
	if err != nil {
		return nil, err
	}
	out := make([]gen.VaccineDismissal, len(rows))
	for i, row := range rows {
		out[i] = serVaccineDismissal(row.ID, row.BabyID, row.SlotKey)
	}
	return gen.ListVaccineDismissals200JSONResponse(out), nil
}

// CreateVaccineDismissal implements POST /api/vaccines/dismissals. REF:
// "{babyId, slotKey} → 201 (idempotent on unique) / 404 unknown baby".
// vaccine_dismissal_baby_slot's unique index on (baby_id, slot_key) is what
// makes a repeat dismissal idempotent: CreateVaccineDismissal's INSERT ...
// ON CONFLICT DO NOTHING affects zero rows on a repeat, which sqlc's :one
// surfaces as pgx.ErrNoRows — caught below and answered with the row that
// already exists via GetVaccineDismissalBySlot, rather than treating the
// conflict as a failure.
func (d Deps) CreateVaccineDismissal(ctx context.Context, req gen.CreateVaccineDismissalRequestObject) (gen.CreateVaccineDismissalResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateVaccineDismissal")
	}
	body := req.Body

	ok, err := babyExists(ctx, d, fam.FamilyID, body.BabyId)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.CreateVaccineDismissal404JSONResponse{Error: "Unknown baby", Code: "NOT_FOUND"}, nil
	}

	row, err := d.Q.CreateVaccineDismissal(ctx, dbgen.CreateVaccineDismissalParams{
		FamilyID:    fam.FamilyID,
		BabyID:      body.BabyId,
		SlotKey:     body.SlotKey,
		DismissedBy: fam.UserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			existing, err := d.Q.GetVaccineDismissalBySlot(ctx, dbgen.GetVaccineDismissalBySlotParams{
				FamilyID: fam.FamilyID,
				BabyID:   body.BabyId,
				SlotKey:  body.SlotKey,
			})
			if err != nil {
				return nil, err
			}
			return gen.CreateVaccineDismissal201JSONResponse(serVaccineDismissal(existing.ID, existing.BabyID, existing.SlotKey)), nil
		}
		return nil, err
	}
	return gen.CreateVaccineDismissal201JSONResponse(serVaccineDismissal(row.ID, row.BabyID, row.SlotKey)), nil
}

// DeleteVaccineDismissal implements DELETE /api/vaccines/dismissals/{id}.
// REF: "{ok:true} / 404".
func (d Deps) DeleteVaccineDismissal(ctx context.Context, req gen.DeleteVaccineDismissalRequestObject) (gen.DeleteVaccineDismissalResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteVaccineDismissal(ctx, dbgen.DeleteVaccineDismissalParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteVaccineDismissal404JSONResponse(notFound()), nil
	}
	return gen.DeleteVaccineDismissal200JSONResponse{Ok: gen.OkOkTrue}, nil
}
