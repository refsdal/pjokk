package restore

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/db"
)

// The family restore (spec 2026-09-11-admin-restore §2): one family that
// no longer exists, back from a snapshot with its original ids. It never
// touches live data — a family that exists is refused — so it cannot clash
// with or overwrite anything.

// How each table relates to a family, for the family restore.
const (
	classGlobal    = "global"     // not the family's; never touched
	classNever     = "never"      // the family's, but not brought back
	classScoped    = "scoped"     // has the family's id in a column
	classViaParent = "via-parent" // reached through a scoped parent
)

// globalTables are not a family's, so a family restore leaves them alone:
// people, their sign-ins, the audit trail, and the tables the backup
// leaves out. A new table that is none of global, never, scoped or
// reached through a parent fails the guard test — someone has to decide.
var globalTables = map[string]bool{
	"users":            true,
	"accounts":         true,
	"sessions":         true,
	"verifications":    true,
	"admin_audit":      true,
	"rate_limit":       true,
	"rate_limits":      true,
	"goose_db_version": true,
	"impersonation":    true,
	"family_invite":    true,
	"job_run":          true,
}

// neverForAFamily are the family's but stay gone: credentials and device
// bindings. A family admin re-issues keys, tablets re-enrol, browsers
// re-subscribe — a deleted family's integrations should not quietly start
// working again.
var neverForAFamily = map[string]bool{
	"api_key":           true,
	"device":            true,
	"push_subscription": true,
}

// userOwned rows belong to a person; when that person's account is gone,
// the row goes too (with anything that depends on it). Every other
// reference to a missing account is credited to the tombstone — the rule
// account deletion applies (queries/admin.sql's ReassignUserReferences,
// and its DeleteCalendarAssigneesForUser).
var userOwned = map[string]bool{
	"organization_members": true,
	"reminder":             true,
	"push_pref":            true,
	"calendar_assignee":    true,
}

// scopeColumns are the columns that carry a family's id.
var scopeColumns = []string{"family_id", "organization_id"}

var (
	ErrFamilyExists        = errors.New("restore: that family exists — only a deleted family can be restored")
	ErrFamilyNotInSnapshot = errors.New("restore: that family is not in the snapshot")
)

// classify places every live table, or names the ones it cannot place.
func classify(s *schema) (map[string]string, []string) {
	class := map[string]string{}
	var unplaced []string
	for _, name := range s.order {
		t := s.tables[name]
		switch {
		case globalTables[name]:
			class[name] = classGlobal
		case neverForAFamily[name]:
			class[name] = classNever
		case name == "organizations" || t.has["family_id"] || t.has["organization_id"]:
			class[name] = classScoped
		default:
			// Parents come first in s.order, so a parent's class is known.
			for _, fk := range t.refs {
				if c := class[fk.table]; c == classScoped || c == classViaParent {
					class[name] = classViaParent
					break
				}
			}
			if class[name] == "" {
				unplaced = append(unplaced, name)
			}
		}
	}
	sort.Strings(unplaced)
	return class, unplaced
}

// UnclassifiedTables names live tables the family restore does not know
// how to treat. The guard test requires none.
func UnclassifiedTables(ctx context.Context, q querier) ([]string, error) {
	s, err := readSchema(ctx, q)
	if err != nil {
		return nil, err
	}
	_, unplaced := classify(s)
	return unplaced, nil
}

// FamilyReport is a Report plus what a family restore has to say.
type FamilyReport struct {
	Report
	FamilyID string
	Name     string
	Slug     string
	// PreviousSlug is set when the family's slug had been taken since and
	// it came back under a new one.
	PreviousSlug    string
	MembersRejoined int
	// MembersDropped are memberships of accounts deleted since.
	MembersDropped int
	// HasAdmin is false when every admin's account has gone: the family
	// comes back unadministrable, to be fixed on its console page.
	HasAdmin bool
}

// Family restores one deleted family from snap. inTx, when given, runs
// inside the restore's transaction just before it commits — the console
// writes its audit row there, so the row exists exactly when the restore
// does.
func Family(ctx context.Context, d Deps, snap *Snapshot, familyID string, inTx func(context.Context, pgx.Tx) error) (*FamilyReport, error) {
	base, err := newReport(snap)
	if err != nil {
		return nil, err
	}
	rep := &FamilyReport{Report: *base, FamilyID: familyID}

	var org map[string]any
	for _, r := range snap.Tables["organizations"] {
		if r["id"] == familyID {
			org = r
			break
		}
	}
	if org == nil {
		return nil, ErrFamilyNotInSnapshot
	}
	var exists bool
	if err := d.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = $1)`, familyID).Scan(&exists); err != nil {
		return nil, fmt.Errorf("restore: check the family: %w", err)
	}
	if exists {
		return nil, ErrFamilyExists
	}

	s, err := readSchema(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	class, unplaced := classify(s)
	if len(unplaced) > 0 {
		return nil, fmt.Errorf("restore: tables with no family-restore rule: %v", unplaced)
	}

	selected := selectFamily(s, class, snap, familyID)
	if err := settleUsers(ctx, d, s, selected); err != nil {
		return nil, err
	}

	// A slug taken since the deletion: the family comes back under a new one.
	slug, _ := org["slug"].(string)
	free, err := freeSlug(ctx, d, slug)
	if err != nil {
		return nil, err
	}
	if free != slug {
		rep.PreviousSlug = slug
		for _, r := range selected["organizations"] {
			r["slug"] = free
		}
	}
	rep.Slug = free
	rep.Name, _ = org["name"].(string)

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("restore: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, name := range s.order {
		rows := selected[name]
		if len(rows) == 0 {
			continue
		}
		n, err := insertRows(ctx, tx, s.tables[name], rows)
		if err != nil {
			return nil, err
		}
		rep.Rows[name] = n
	}
	if inTx != nil {
		if err := inTx(ctx, tx); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("restore: commit: %w", err)
	}

	rep.MembersRejoined = len(selected["organization_members"])
	rep.MembersDropped = countScoped(snap.Tables["organization_members"], familyID) - rep.MembersRejoined
	for _, r := range selected["organization_member_roles"] {
		if role, _ := r["role"].(string); role == "admin" || role == "owner" {
			rep.HasAdmin = true
		}
	}

	rep.PhotosRestored, rep.PhotosMissing, err = restorePhotos(ctx, d.Storage, photoKeys(selected["milestone_photo"]))
	if err != nil {
		return rep, err
	}
	return rep, nil
}

// selectFamily picks the family's rows from the snapshot: the family's
// own row, every scoped table's rows carrying its id, and every
// via-parent table's rows whose parent was picked. Rows are copied, so the
// caller may rewrite them.
func selectFamily(s *schema, class map[string]string, snap *Snapshot, familyID string) map[string][]map[string]any {
	selected := map[string][]map[string]any{}
	ids := map[string]map[string]bool{} // table → its picked rows' ids
	for _, name := range s.order {
		var pick func(map[string]any) bool
		switch class[name] {
		case classScoped:
			pick = func(r map[string]any) bool {
				if name == "organizations" {
					return r["id"] == familyID
				}
				for _, c := range scopeColumns {
					if r[c] == familyID {
						return true
					}
				}
				return false
			}
		case classViaParent:
			refs := s.tables[name].refs
			pick = func(r map[string]any) bool {
				for _, fk := range refs {
					if v, ok := r[fk.column].(string); ok && ids[fk.table][v] {
						return true
					}
				}
				return false
			}
		default:
			continue
		}
		for _, r := range snap.Tables[name] {
			if !pick(r) {
				continue
			}
			row := make(map[string]any, len(r))
			for k, v := range r {
				row[k] = v
			}
			selected[name] = append(selected[name], row)
			if id, ok := row["id"].(string); ok {
				if ids[name] == nil {
					ids[name] = map[string]bool{}
				}
				ids[name][id] = true
			}
		}
	}
	return selected
}

// settleUsers deals with references to accounts deleted since: a row that
// belongs to such a person is dropped, with every picked row that depends
// on a dropped one; any other reference is credited to the tombstone.
func settleUsers(ctx context.Context, d Deps, s *schema, selected map[string][]map[string]any) error {
	var referenced []string
	for name, rows := range selected {
		for _, fk := range s.tables[name].refs {
			if fk.table != "users" {
				continue
			}
			for _, r := range rows {
				if v, ok := r[fk.column].(string); ok {
					referenced = append(referenced, v)
				}
			}
		}
	}
	alive := map[string]bool{}
	if len(referenced) > 0 {
		rows, err := d.Pool.Query(ctx, `SELECT "id" FROM "users" WHERE "id" = ANY($1)`, referenced)
		if err != nil {
			return fmt.Errorf("restore: look up the family's people: %w", err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			alive[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}

	dropped := map[string]map[string]bool{}
	for _, name := range s.order {
		rows := selected[name]
		if len(rows) == 0 {
			continue
		}
		kept := rows[:0]
		for _, r := range rows {
			drop := false
			for _, fk := range s.tables[name].refs {
				v, ok := r[fk.column].(string)
				if !ok {
					continue
				}
				switch {
				case fk.table == "users" && !alive[v]:
					if userOwned[name] {
						drop = true
					} else {
						r[fk.column] = db.TombstoneID
					}
				case dropped[fk.table][v]:
					drop = true
				}
			}
			if drop {
				if id, ok := r["id"].(string); ok {
					if dropped[name] == nil {
						dropped[name] = map[string]bool{}
					}
					dropped[name][id] = true
				}
				continue
			}
			kept = append(kept, r)
		}
		selected[name] = kept
	}
	return nil
}

// freeSlug is slug if no family holds it now, else the first free of
// slug-restored, slug-restored-2, …
func freeSlug(ctx context.Context, d Deps, slug string) (string, error) {
	for i := 1; ; i++ {
		candidate := slug
		switch {
		case i == 2:
			candidate = slug + "-restored"
		case i > 2:
			candidate = fmt.Sprintf("%s-restored-%d", slug, i-1)
		}
		var taken bool
		if err := d.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = $1)`, candidate).Scan(&taken); err != nil {
			return "", fmt.Errorf("restore: check the slug: %w", err)
		}
		if !taken {
			return candidate, nil
		}
	}
}

func countScoped(rows []map[string]any, familyID string) int {
	n := 0
	for _, r := range rows {
		if r["organization_id"] == familyID {
			n++
		}
	}
	return n
}

// DeletedFamily is a family in a snapshot that does not exist now.
type DeletedFamily struct {
	ID        string
	Name      string
	Slug      string
	Members   int
	Babies    int
	CreatedAt string
}

// DeletedFamilies lists the families in snap that no longer exist — the
// ones a family restore could bring back.
func DeletedFamilies(ctx context.Context, q querier, snap *Snapshot) ([]DeletedFamily, error) {
	var ids []string
	for _, r := range snap.Tables["organizations"] {
		if id, ok := r["id"].(string); ok {
			ids = append(ids, id)
		}
	}
	live := map[string]bool{}
	if len(ids) > 0 {
		rows, err := q.Query(ctx, `SELECT "id" FROM "organizations" WHERE "id" = ANY($1)`, ids)
		if err != nil {
			return nil, fmt.Errorf("restore: look up the families: %w", err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			live[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	var out []DeletedFamily
	for _, r := range snap.Tables["organizations"] {
		id, _ := r["id"].(string)
		if id == "" || live[id] {
			continue
		}
		f := DeletedFamily{ID: id}
		f.Name, _ = r["name"].(string)
		f.Slug, _ = r["slug"].(string)
		f.CreatedAt, _ = r["created_at"].(string)
		f.Members = countScoped(snap.Tables["organization_members"], id)
		for _, b := range snap.Tables["baby"] {
			if b["family_id"] == id {
				f.Babies++
			}
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
