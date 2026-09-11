package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// Keyset paging on the console's three lists (docs/superpowers/specs/
// 2026-09-11-admin-user-support-design.md §2): {items, nextCursor}, newest
// first, a cursor over (created_at, id), 50 by default and 200 at most.
// -----------------------------------------------------------------------

// adminList GETs one page of an admin list and hands back its items as an
// ArrayResult, so assertions about a page read the way they did when the
// lists were bare arrays.
func adminList(t *testing.T, a *testrig.AppRig, path, cookie string) *testrig.ArrayResult {
	t.Helper()
	res := a.Do(http.MethodGet, path, cookie, nil)
	out := &testrig.ArrayResult{Status: res.Status, Raw: res.Raw, Header: res.Header}
	if items, ok := res.JSON["items"].([]any); ok {
		out.JSON = items
	}
	return out
}

// walk follows nextCursor from path until the end, returning every item's id
// in the order served and how many pages it took.
func walk(t *testing.T, a *testrig.AppRig, path, cookie string, limit int) (ids []string, pages int) {
	t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	cursor := ""
	for {
		p := fmt.Sprintf("%s%slimit=%d", path, sep, limit)
		if cursor != "" {
			p += "&cursor=" + url.QueryEscape(cursor)
		}
		res := a.Do(http.MethodGet, p, cookie, nil)
		if res.Status != http.StatusOK {
			t.Fatalf("GET %s = %d %s", p, res.Status, res.Raw)
		}
		if _, ok := res.JSON["nextCursor"]; !ok {
			t.Fatalf("GET %s: no nextCursor field in %s", p, res.Raw)
		}
		items, _ := res.JSON["items"].([]any)
		if len(items) > limit {
			t.Fatalf("GET %s served %d items, over the limit of %d", p, len(items), limit)
		}
		for _, it := range items {
			m, _ := it.(map[string]any)
			id, _ := m["id"].(string)
			ids = append(ids, id)
		}
		pages++
		next, _ := res.JSON["nextCursor"].(string)
		if next == "" {
			return ids, pages
		}
		cursor = next
		if pages > 200 {
			t.Fatalf("GET %s: runaway paging", path)
		}
	}
}

// dbOrder is the order a list must serve, straight from the table.
func dbOrder(t *testing.T, a *testrig.AppRig, sql string, args ...any) []string {
	t.Helper()
	rows, err := a.Rig.Pool.Query(context.Background(), sql, args...)
	if err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ids = append(ids, id)
	}
	return ids
}

func note(t *testing.T, a *testrig.AppRig, cookie, action, target string) {
	t.Helper()
	res := a.Do(http.MethodPost, "/api/admin/audit", cookie, map[string]any{
		"action": action, "target": target, "detail": "paging test",
	})
	if res.Status != http.StatusCreated && res.Status != http.StatusOK {
		t.Fatalf("audit note = %d %s", res.Status, res.Raw)
	}
}

func sameOrder(t *testing.T, what string, got, want []string) {
	t.Helper()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("%s served\n  %v\nwant (newest first, each once)\n  %v", what, got, want)
	}
}

func TestAdminListsWalkEveryRowOnceNewestFirst(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")
	for i := range 4 {
		a.SignUp(fmt.Sprintf("Person %d", i), fmt.Sprintf("person%d@example.com", i))
	}
	for i := range 3 {
		a.NewFamily(fmt.Sprintf("Family %d", i), fmt.Sprintf("founder%d@example.com", i))
	}
	for i := range 5 {
		note(t, a, cookie, "support.call", fmt.Sprintf("ticket-%d", i))
	}

	users, pages := walk(t, a, "/api/admin/users", cookie, 2)
	want := dbOrder(t, a, `SELECT "id" FROM "users" WHERE "id" <> $1 ORDER BY "created_at" DESC, "id" DESC`, db.TombstoneID)
	sameOrder(t, "users", users, want)
	if wantPages := (len(want) + 1) / 2; pages != wantPages {
		t.Errorf("users took %d pages of 2 for %d rows, want %d (the last page must say there is no next)", pages, len(want), wantPages)
	}

	families, _ := walk(t, a, "/api/admin/families", cookie, 2)
	sameOrder(t, "families", families, dbOrder(t, a, `SELECT "id" FROM "organizations" ORDER BY "created_at" DESC, "id" DESC`))

	audit, _ := walk(t, a, "/api/admin/audit", cookie, 2)
	sameOrder(t, "audit", audit, dbOrder(t, a, `SELECT "id" FROM "admin_audit" ORDER BY "created_at" DESC, "id" DESC`))
}

func TestAdminAuditPageIsStableWhileRowsArrive(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")
	for i := range 4 {
		note(t, a, cookie, "support.call", fmt.Sprintf("ticket-%d", i))
	}
	first := a.Do(http.MethodGet, "/api/admin/audit?limit=2", cookie, nil)
	cursor, _ := first.JSON["nextCursor"].(string)
	if first.Status != http.StatusOK || cursor == "" {
		t.Fatalf("first page = %d %s", first.Status, first.Raw)
	}
	seen := map[string]bool{}
	for _, it := range first.JSON["items"].([]any) {
		seen[it.(map[string]any)["id"].(string)] = true
	}

	// A new entry lands between the two reads — an offset would shift it
	// into the next page and repeat a row.
	note(t, a, cookie, "support.call", "late-arrival")

	second := adminList(t, a, "/api/admin/audit?limit=2&cursor="+url.QueryEscape(cursor), cookie)
	if second.Status != http.StatusOK || len(second.JSON) != 2 {
		t.Fatalf("second page = %d %s", second.Status, second.Raw)
	}
	for _, it := range second.JSON {
		m := it.(map[string]any)
		if seen[m["id"].(string)] {
			t.Errorf("second page repeats %v from the first", m["id"])
		}
		if m["target"] == "late-arrival" {
			t.Errorf("second page served the row that arrived after the first page")
		}
	}
}

func TestAdminListsRejectAMalformedCursor(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")
	for _, path := range []string{"/api/admin/users", "/api/admin/families", "/api/admin/audit"} {
		for _, cursor := range []string{"not-a-cursor", "bm90LWEtdGltZXxpZA"} { // the second is base64 of "not-a-time|id"
			res := a.Do(http.MethodGet, path+"?cursor="+cursor, cookie, nil)
			if res.Status != http.StatusBadRequest || res.JSON["code"] != "VALIDATION" {
				t.Errorf("%s?cursor=%s = %d %v, want 400 VALIDATION", path, cursor, res.Status, res.JSON)
			}
		}
	}
}

func TestAdminListsBoundTheLimit(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")
	for _, path := range []string{"/api/admin/users", "/api/admin/families", "/api/admin/audit"} {
		for _, limit := range []string{"0", "201"} {
			if res := a.Do(http.MethodGet, path+"?limit="+limit, cookie, nil); res.Status != http.StatusBadRequest {
				t.Errorf("%s?limit=%s = %d, want 400", path, limit, res.Status)
			}
		}
	}

	// No limit means 50, with a cursor to the rest.
	for i := range 52 {
		note(t, a, cookie, "support.call", fmt.Sprintf("ticket-%d", i))
	}
	res := a.Do(http.MethodGet, "/api/admin/audit", cookie, nil)
	items, _ := res.JSON["items"].([]any)
	next, _ := res.JSON["nextCursor"].(string)
	if len(items) != 50 || next == "" {
		t.Errorf("default page = %d items, nextCursor %q; want 50 and a cursor", len(items), next)
	}
}

func TestAdminListFiltersCombineWithTheCursor(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Ops")
	for i := range 3 {
		a.SignUp(fmt.Sprintf("Kari Berg %d", i), fmt.Sprintf("berg%d@example.com", i))
	}
	a.SignUp("Someone Else", "else@example.com")

	users, _ := walk(t, a, "/api/admin/users?query=berg", cookie, 1)
	sameOrder(t, "users?query=berg", users, dbOrder(t, a,
		`SELECT "id" FROM "users" WHERE "email" LIKE 'berg%' ORDER BY "created_at" DESC, "id" DESC`))

	for range 3 {
		note(t, a, cookie, "support.call", "ticket-1")
	}
	for i := range 2 {
		note(t, a, cookie, "support.call", fmt.Sprintf("ticket-2-%d", i))
	}
	audit, _ := walk(t, a, "/api/admin/audit?target=ticket-1", cookie, 2)
	sameOrder(t, "audit?target=ticket-1", audit, dbOrder(t, a,
		`SELECT "id" FROM "admin_audit" WHERE "target" = 'ticket-1' ORDER BY "created_at" DESC, "id" DESC`))
}
