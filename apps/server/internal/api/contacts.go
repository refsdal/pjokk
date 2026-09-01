package api

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/contacts.ts (REF §A1's contacts.ts
// route table): GET/POST /api/contacts, PATCH/DELETE /api/contacts/{id}.
// calendar.go is the sibling file with the same tenancy-backstop shape
// (links.go's refsValid) but two link tables and a more involved PATCH —
// read that file's doc comment for the shared reasoning; this one is
// shorter.
//
// # Divergence: no billing gate
//
// apps/api/src/routes/contacts.ts soft-locks POST behind canUse(family,
// "contacts") (premium); read/edit/delete stay open even on a downgrade.
// CLAUDE.md's entitlement helper always returns true on this port (see
// other_logs.go's package doc comment, which removed the same gate for
// the six Phase 3 kinds) — contact create is free here, with no 402 path
// at all.
//
// # Link-set replacement: one transaction
//
// contact_baby carries no family_id of its own, so a caller-supplied
// babyId is checked against this family's babies (links.go's refsValid)
// before it is ever linked. Create commits the contact row and its link
// rows in one transaction; update commits the column patch and the link
// REPLACEMENT (delete-then-reinsert) in one transaction too —
// apps/api/src/db/scoped.ts's comment on this exact code notes that D1's
// batch() could not span the ownership check, which is why this needs to
// be a real transaction rather than two separate statements.

func serContact(row dbgen.GetContactRow, babies []dbgen.ContactBabiesForContactRow) gen.Contact {
	out := gen.Contact{
		Id:      row.ID,
		Name:    row.Name,
		Role:    row.Role,
		Phone:   row.Phone,
		Email:   row.Email,
		Website: row.Website,
		Notes:   row.Notes,
		Babies: make([]struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}, len(babies)),
	}
	if row.Icon != nil {
		v := gen.ContactIcon(*row.Icon)
		out.Icon = &v
	}
	for i, b := range babies {
		out.Babies[i] = struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}{Id: b.ID, Name: b.Name}
	}
	return out
}

// getContactHydrated re-reads one contact plus its hydrated baby links —
// the shared re-read Create/Update use after a write.
func (d Deps) getContactHydrated(ctx context.Context, familyID, id string) (gen.Contact, error) {
	row, err := d.Q.GetContact(ctx, dbgen.GetContactParams{FamilyID: familyID, ID: id})
	if err != nil {
		return gen.Contact{}, err
	}
	babies, err := d.Q.ContactBabiesForContact(ctx, id)
	if err != nil {
		return gen.Contact{}, err
	}
	return serContact(row, babies), nil
}

// ListContacts implements GET /api/contacts. REF: "Contact[] ordered by
// name".
func (d Deps) ListContacts(ctx context.Context, req gen.ListContactsRequestObject) (gen.ListContactsResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListContacts(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}

	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	var babyRows []dbgen.ContactBabiesForContactsRow
	if len(ids) > 0 {
		babyRows, err = d.Q.ContactBabiesForContacts(ctx, ids)
		if err != nil {
			return nil, err
		}
	}
	byContact := make(map[string][]dbgen.ContactBabiesForContactRow, len(rows))
	for _, br := range babyRows {
		byContact[br.ContactID] = append(byContact[br.ContactID], dbgen.ContactBabiesForContactRow{ID: br.ID, Name: br.Name})
	}

	out := make([]gen.Contact, len(rows))
	for i, row := range rows {
		out[i] = serContact(dbgen.GetContactRow{
			ID: row.ID, Name: row.Name, Role: row.Role, Icon: row.Icon,
			Phone: row.Phone, Email: row.Email, Website: row.Website, Notes: row.Notes,
		}, byContact[row.ID])
	}
	return gen.ListContacts200JSONResponse(out), nil
}

// CreateContact implements POST /api/contacts. REF: "{name, role?, icon?,
// phone?, email?, website?, notes?, babyIds[]} → 201; 400
// INVALID_REFERENCE on an unknown baby". Free — see this file's doc
// comment for why there is no 402 path.
func (d Deps) CreateContact(ctx context.Context, req gen.CreateContactRequestObject) (gen.CreateContactResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateContact")
	}
	body := req.Body

	babyIDs := uniqueStrings(derefStrSlice(body.BabyIds))
	ok, err := refsValid(ctx, d, fam.FamilyID, babyIDs, nil)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.CreateContact400JSONResponse{Error: "Unknown baby", Code: "INVALID_REFERENCE"}, nil
	}

	var icon, email *string
	if body.Icon != nil {
		v := string(*body.Icon)
		icon = &v
	}
	if body.Email != nil {
		v := string(*body.Email)
		email = &v
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	id, err := qtx.CreateContact(ctx, dbgen.CreateContactParams{
		FamilyID: fam.FamilyID,
		Name:     body.Name,
		Role:     body.Role,
		Icon:     icon,
		Phone:    body.Phone,
		Email:    email,
		Website:  body.Website,
		Notes:    body.Notes,
	})
	if err != nil {
		return nil, err
	}
	for _, babyID := range babyIDs {
		if err := qtx.CreateContactBaby(ctx, dbgen.CreateContactBabyParams{ContactID: id, BabyID: babyID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	created, err := d.getContactHydrated(ctx, fam.FamilyID, id)
	if err != nil {
		return nil, err
	}
	return gen.CreateContact201JSONResponse(created), nil
}

// UpdateContact implements PATCH /api/contacts/{id}. REF: "partial
// (nullable clears) → Contact / 404; babyIds present replaces the link
// set". See patch.go for the omitted-vs-null presence-detection pattern
// this endpoint needs, same as feeds.go's UpdateFeed.
func (d Deps) UpdateContact(ctx context.Context, req gen.UpdateContactRequestObject) (gen.UpdateContactResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	fields, err := rawBodyFields(ctx)
	if err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errNoRequestBody("UpdateContact")
	}

	nameSet, nameVal, err := patchField[string](fields, "name")
	if err != nil {
		return nil, err
	}
	roleSet, roleVal, err := patchField[string](fields, "role")
	if err != nil {
		return nil, err
	}
	iconSet, iconVal, err := patchField[string](fields, "icon")
	if err != nil {
		return nil, err
	}
	phoneSet, phoneVal, err := patchField[string](fields, "phone")
	if err != nil {
		return nil, err
	}
	emailSet, emailVal, err := patchField[string](fields, "email")
	if err != nil {
		return nil, err
	}
	websiteSet, websiteVal, err := patchField[string](fields, "website")
	if err != nil {
		return nil, err
	}
	notesSet, notesVal, err := patchField[string](fields, "notes")
	if err != nil {
		return nil, err
	}
	babyIdsSet, babyIdsVal, err := patchField[[]string](fields, "babyIds")
	if err != nil {
		return nil, err
	}

	var babyIDs []string
	if babyIdsSet && babyIdsVal != nil {
		babyIDs = uniqueStrings(*babyIdsVal)
	}
	// refsValid runs BEFORE the existence check below — apps/api/src/routes/
	// contacts.ts's updateContact calls babiesValid before it ever attempts
	// the update, so a PATCH naming both a nonexistent/cross-family contact
	// id AND an invalid babyId answers 400 INVALID_REFERENCE, not 404 (see
	// TestUpdateContactUnknownIdWithInvalidBabyIdIs400).
	ok, err := refsValid(ctx, d, fam.FamilyID, babyIDs, nil)
	if err != nil {
		return nil, err
	}
	if !ok {
		return gen.UpdateContact400JSONResponse{Error: "Unknown baby", Code: "INVALID_REFERENCE"}, nil
	}

	if _, err := d.Q.GetContact(ctx, dbgen.GetContactParams{FamilyID: fam.FamilyID, ID: req.Id}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.UpdateContact404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	anySet := nameSet || roleSet || iconSet || phoneSet || emailSet || websiteSet || notesSet
	if !anySet && !babyIdsSet {
		existing, err := d.getContactHydrated(ctx, fam.FamilyID, req.Id)
		if err != nil {
			return nil, err
		}
		return gen.UpdateContact200JSONResponse(existing), nil
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := d.Q.WithTx(tx)

	if anySet {
		n, err := qtx.UpdateContact(ctx, dbgen.UpdateContactParams{
			FamilyID:   fam.FamilyID,
			ID:         req.Id,
			NameSet:    nameSet,
			NameVal:    nameVal,
			RoleSet:    roleSet,
			RoleVal:    roleVal,
			IconSet:    iconSet,
			IconVal:    iconVal,
			PhoneSet:   phoneSet,
			PhoneVal:   phoneVal,
			EmailSet:   emailSet,
			EmailVal:   emailVal,
			WebsiteSet: websiteSet,
			WebsiteVal: websiteVal,
			NotesSet:   notesSet,
			NotesVal:   notesVal,
		})
		if err != nil {
			return nil, err
		}
		// Re-check ownership against the UPDATE's own row count rather than
		// trusting the pre-check above: a concurrent delete between that
		// check and this transaction's UPDATE would otherwise write nothing
		// and still report success. Mirrors apps/api/src/db/scoped.ts's
		// updateContact, which treats a zero-row update the same as the
		// "not found" branch of its own ownership check.
		if n == 0 {
			return gen.UpdateContact404JSONResponse(notFound()), nil
		}
	}

	if babyIdsSet {
		if err := qtx.DeleteContactBabies(ctx, req.Id); err != nil {
			return nil, err
		}
		for _, babyID := range babyIDs {
			if err := qtx.CreateContactBaby(ctx, dbgen.CreateContactBabyParams{ContactID: req.Id, BabyID: babyID}); err != nil {
				return nil, err
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	updated, err := d.getContactHydrated(ctx, fam.FamilyID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.UpdateContact200JSONResponse(updated), nil
}

// DeleteContact implements DELETE /api/contacts/{id}. REF: "{ok:true} /
// 404". Link rows go with it via ON DELETE CASCADE.
func (d Deps) DeleteContact(ctx context.Context, req gen.DeleteContactRequestObject) (gen.DeleteContactResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.DeleteContact(ctx, dbgen.DeleteContactParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.DeleteContact404JSONResponse(notFound()), nil
	}
	return gen.DeleteContact200JSONResponse{Ok: gen.OkOkTrue}, nil
}
