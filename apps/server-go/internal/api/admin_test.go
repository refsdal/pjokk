package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/db"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// -----------------------------------------------------------------------
// System-admin console — ports apps/api/test/admin.test.ts's "system admin"
// describe block and apps/api/test/security.test.ts's "safe user deletion
// (M5)" block, plus the coverage the TypeScript suite could not have: the
// user-support surface (list/ban/unban/password/session revocation/
// impersonation) that used to come from better-auth's admin plugin and is
// now ours (REF §A1's "NEW in Go" table).
//
// One test-shape difference from the TS suite: testrig.Setup truncates every
// table per test, so these assert absolute counts where admin.test.ts had to
// assert deltas against a database shared by the whole file. The only row
// that survives truncation is the "Deleted user" tombstone, which
// db.EnsureTombstone re-inserts — hence the +1 in the user counts below.
// -----------------------------------------------------------------------

// sessionCookieName mirrors internal/auth's unexported constant (testrig
// duplicates it for the same reason).
const sessionCookieName = "limen_session"

// makeSysadmin promotes a user to the system-admin role. It writes the
// column directly, exactly as admin.test.ts's makeSysadmin does: there is no
// endpoint for this on purpose — the first sysadmin is bootstrapped by an
// operator, never minted over HTTP.
func makeSysadmin(t *testing.T, a *testrig.AppRig, userID string) {
	t.Helper()
	if _, err := a.Rig.Pool.Exec(context.Background(),
		`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, userID); err != nil {
		t.Fatalf("makeSysadmin(%q): %v", userID, err)
	}
}

// userIDByEmail resolves an account created through testrig's helpers (which
// return cookies and family ids, not user ids).
func userIDByEmail(t *testing.T, a *testrig.AppRig, email string) string {
	t.Helper()
	var id string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "users" WHERE "email" = $1`, email).Scan(&id); err != nil {
		t.Fatalf("userIDByEmail(%q): %v", email, err)
	}
	return id
}

// auditRow is one row of the append-only trail, read straight from the table
// so the assertions do not depend on the endpoint that lists it.
type auditRow struct {
	AdminID, Action, Target, Detail string
}

func auditRows(t *testing.T, a *testrig.AppRig) []auditRow {
	t.Helper()
	rows, err := a.Rig.Pool.Query(context.Background(),
		`SELECT "admin_id", "action", "target", COALESCE("detail", '')
		 FROM "admin_audit" ORDER BY "created_at", "id"`)
	if err != nil {
		t.Fatalf("read audit trail: %v", err)
	}
	defer rows.Close()
	var out []auditRow
	for rows.Next() {
		var row auditRow
		if err := rows.Scan(&row.AdminID, &row.Action, &row.Target, &row.Detail); err != nil {
			t.Fatalf("scan audit row: %v", err)
		}
		out = append(out, row)
	}
	return out
}

// findAudit returns the first trail entry with this action, or fails.
func findAudit(t *testing.T, a *testrig.AppRig, action string) auditRow {
	t.Helper()
	rows := auditRows(t, a)
	for _, row := range rows {
		if row.Action == action {
			return row
		}
	}
	t.Fatalf("no %q entry in the audit trail: %+v", action, rows)
	return auditRow{}
}

// sessionCookieFrom extracts the session cookie a response set — how the
// impersonation round trip moves from one identity to the next.
func sessionCookieFrom(t *testing.T, res *testrig.Result) string {
	t.Helper()
	for _, c := range (&http.Response{Header: res.Header}).Cookies() {
		if c.Name == sessionCookieName && c.Value != "" {
			return c.Name + "=" + c.Value
		}
	}
	t.Fatalf("no %s cookie in response headers: %v", sessionCookieName, res.Header)
	return ""
}

// tokenOf strips the "limen_session=" prefix off a Cookie header value.
func tokenOf(cookie string) string {
	return strings.TrimPrefix(cookie, sessionCookieName+"=")
}

// signInWith drives the real credential sign-in route with an arbitrary
// password (testrig.SignIn always uses the rig's fixed one), for the
// password-set test.
func signInWith(t *testing.T, a *testrig.AppRig, email, password string) *testrig.Result {
	t.Helper()
	body, err := json.Marshal(map[string]string{"credential": email, "password": password})
	if err != nil {
		t.Fatalf("marshal sign-in body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, auth.BasePath+"/signin/credential", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return a.DoRequest(req)
}

// sysadminRig is the standard starting point: one family, whose admin is
// also promoted to system admin.
func sysadminRig(t *testing.T, familyName string) (a *testrig.AppRig, familyID, cookie, adminID string) {
	t.Helper()
	a = testrig.App(t)
	familyID, cookie = a.NewFamily(familyName, "sysadmin@example.com")
	adminID = userIDByEmail(t, a, "sysadmin@example.com")
	makeSysadmin(t, a, adminID)
	return a, familyID, cookie, adminID
}

// -----------------------------------------------------------------------
// The gate
// -----------------------------------------------------------------------

// Ports admin.test.ts's "gates every /api/admin endpoint on the admin role",
// widened to every route in the console (the TS test only probed /stats) and
// to the two callers the TypeScript predecessor's middleware could not
// express: an API key, and an anonymous request.
func TestAdminRoutesRequireSysadmin(t *testing.T) {
	a := testrig.App(t)
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	userID := userIDByEmail(t, a, "parent@example.com")
	key := a.CreateAPIKey(familyID, userID)

	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/stats"},
		{http.MethodGet, "/api/admin/families"},
		{http.MethodDelete, "/api/admin/families/" + familyID},
		{http.MethodGet, "/api/admin/users"},
		{http.MethodPost, "/api/admin/users/" + userID + "/delete"},
		{http.MethodPost, "/api/admin/users/" + userID + "/ban"},
		{http.MethodPost, "/api/admin/users/" + userID + "/unban"},
		{http.MethodPost, "/api/admin/users/" + userID + "/password"},
		{http.MethodPost, "/api/admin/users/" + userID + "/sessions/revoke"},
		{http.MethodPost, "/api/admin/users/" + userID + "/impersonate"},
		{http.MethodGet, "/api/admin/audit"},
		{http.MethodPost, "/api/admin/audit"},
	}

	for _, route := range routes {
		// A family admin is not a system admin.
		var body any
		if route.path == "/api/admin/users/"+userID+"/password" {
			body = map[string]any{"password": "hunter2hunter2"}
		}
		if route.method == http.MethodPost && strings.HasSuffix(route.path, "/api/admin/audit") {
			body = map[string]any{"action": "poke", "target": "x"}
		}

		res := a.Do(route.method, route.path, cookie, body)
		if res.Status != http.StatusForbidden || res.JSON["code"] != "FORBIDDEN" {
			t.Errorf("%s %s as a family admin = %d %s, want 403 FORBIDDEN",
				route.method, route.path, res.Status, res.Raw)
		}

		anon := a.Do(route.method, route.path, "", body)
		if anon.Status != http.StatusUnauthorized || anon.JSON["code"] != "UNAUTHENTICATED" {
			t.Errorf("%s %s anonymous = %d %s, want 401 UNAUTHENTICATED",
				route.method, route.path, anon.Status, anon.Raw)
		}

		withKey := bearerDo(a, route.method, route.path, key, body)
		if withKey.Status != http.StatusForbidden || withKey.JSON["code"] != "FORBIDDEN" {
			t.Errorf("%s %s with an API key = %d %s, want 403 FORBIDDEN",
				route.method, route.path, withKey.Status, withKey.Raw)
		}
	}

	makeSysadmin(t, a, userID)
	if res := a.Do(http.MethodGet, "/api/admin/stats", cookie, nil); res.Status != http.StatusOK {
		t.Fatalf("after promotion, GET /api/admin/stats = %d %s, want 200", res.Status, res.Raw)
	}
}

// -----------------------------------------------------------------------
// Stats + family overview — admin.test.ts's "reports platform stats and
// family overview"
// -----------------------------------------------------------------------

func TestAdminStatsAndFamilyOverview(t *testing.T) {
	a, familyID, cookie, _ := sysadminRig(t, "Admin family")
	babyID := a.NewBaby(familyID, "Ada")

	// A second family, so the overview has more than one row to order.
	otherID, otherCookie := a.NewFamily("Other family", "other@example.com")
	a.NewBaby(otherID, "Bo")

	feed := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 100,
	})
	if feed.Status != http.StatusCreated {
		t.Fatalf("seed feed: %d %s", feed.Status, feed.Raw)
	}
	diaper := a.Do(http.MethodPost, "/api/diapers", otherCookie, map[string]any{
		"babyId": a.NewBaby(otherID, "Cleo"),
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "wet",
	})
	if diaper.Status != http.StatusCreated {
		t.Fatalf("seed diaper: %d %s", diaper.Status, diaper.Raw)
	}

	stats := a.Do(http.MethodGet, "/api/admin/stats", cookie, nil)
	if stats.Status != http.StatusOK {
		t.Fatalf("GET /api/admin/stats = %d %s", stats.Status, stats.Raw)
	}
	want := map[string]float64{
		"families": 2,
		// Two sign-ups plus the "Deleted user" tombstone (see this file's
		// header comment).
		"users":             3,
		"babies":            3,
		"coreLogs":          2, // one feed + one diaper, no sleeps
		"pushSubscriptions": 0,
		"usersLast7d":       3,
	}
	for field, expected := range want {
		if stats.JSON[field] != expected {
			t.Errorf("stats.%s = %v, want %v (body %s)", field, stats.JSON[field], expected, stats.Raw)
		}
	}

	families := a.DoArray(http.MethodGet, "/api/admin/families", cookie, nil)
	if families.Status != http.StatusOK {
		t.Fatalf("GET /api/admin/families = %d %s", families.Status, families.Raw)
	}
	if len(families.JSON) != 2 {
		t.Fatalf("families = %v, want 2 rows", families.JSON)
	}

	var mine map[string]any
	for _, row := range families.JSON {
		entry, _ := row.(map[string]any)
		if entry["name"] == "Admin family" {
			mine = entry
		}
	}
	if mine == nil {
		t.Fatalf("no \"Admin family\" row in %v", families.JSON)
	}
	if mine["id"] != familyID {
		t.Errorf("id = %v, want %q", mine["id"], familyID)
	}
	if mine["members"] != float64(1) {
		t.Errorf("members = %v, want 1", mine["members"])
	}
	if mine["babies"] != float64(1) {
		t.Errorf("babies = %v, want 1", mine["babies"])
	}
	if mine["plan"] != "free" {
		t.Errorf("plan = %v, want %q", mine["plan"], "free")
	}
	if mine["lastFeedAt"] == nil {
		t.Errorf("lastFeedAt = nil, want the seeded feed's time")
	}

	// A family that has never logged a feed reports null rather than an
	// epoch-zero timestamp.
	for _, row := range families.JSON {
		entry, _ := row.(map[string]any)
		if entry["name"] == "Other family" && entry["lastFeedAt"] != nil {
			t.Errorf("Other family lastFeedAt = %v, want null", entry["lastFeedAt"])
		}
	}
}

// -----------------------------------------------------------------------
// Family delete — admin.test.ts's "deletes a family with cascade and writes
// the audit trail"
// -----------------------------------------------------------------------

func TestAdminDeleteFamilyCascadesAndAudits(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Admin family")

	victimID, victimCookie := a.NewFamily("Doomed family", "doomed@example.com")
	babyID := a.NewBaby(victimID, "Ada")
	feed := a.Do(http.MethodPost, "/api/feeds", victimCookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 90,
	})
	if feed.Status != http.StatusCreated {
		t.Fatalf("seed feed: %d %s", feed.Status, feed.Raw)
	}

	del := a.Do(http.MethodDelete, "/api/admin/families/"+victimID, cookie, nil)
	if del.Status != http.StatusOK || del.JSON["ok"] != true {
		t.Fatalf("DELETE = %d %s, want 200 {ok:true}", del.Status, del.Raw)
	}

	assertCount(t, a, `SELECT COUNT(*)::int FROM "organizations" WHERE "id" = $1`, 0, victimID)
	assertCount(t, a, `SELECT COUNT(*)::int FROM "feed_log" WHERE "family_id" = $1`, 0, victimID)
	assertCount(t, a, `SELECT COUNT(*)::int FROM "baby" WHERE "family_id" = $1`, 0, victimID)

	row := findAudit(t, a, "family.delete")
	if row.AdminID != adminID || row.Target != victimID || row.Detail != "Doomed family" {
		t.Errorf("audit row = %+v, want admin %q target %q detail %q",
			row, adminID, victimID, "Doomed family")
	}

	// The trail is served too, newest first.
	list := a.DoArray(http.MethodGet, "/api/admin/audit", cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) == 0 {
		t.Fatalf("GET /api/admin/audit = %d %s", list.Status, list.Raw)
	}
	first, _ := list.JSON[0].(map[string]any)
	if first["action"] != "family.delete" || first["target"] != victimID {
		t.Errorf("newest audit entry = %v, want the family.delete row", first)
	}
	if first["adminName"] != "Rig admin" {
		t.Errorf("adminName = %v, want the admin's name joined in", first["adminName"])
	}

	if missing := a.Do(http.MethodDelete, "/api/admin/families/nope", cookie, nil); missing.Status != http.StatusNotFound {
		t.Errorf("DELETE unknown family = %d %s, want 404", missing.Status, missing.Raw)
	}
}

func assertCount(t *testing.T, a *testrig.AppRig, query string, want int, args ...any) {
	t.Helper()
	var n int
	if err := a.Rig.Pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	if n != want {
		t.Errorf("%q = %d, want %d", query, n, want)
	}
}

// -----------------------------------------------------------------------
// Safe user deletion — security.test.ts's "safe user deletion (M5)" plus
// admin.test.ts's calendar-FK case, plus the two hazards this port found
// that the TypeScript predecessor's list did not cover.
// -----------------------------------------------------------------------

func TestAdminDeleteUserTombstonesAttributionThenDeletes(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")
	babyID := a.NewBaby(familyID, "Ada")

	victimID := a.SignUp("Leaving caretaker", "victim@example.com")
	victimCookie := a.AddMember(familyID, victimID, auth.RoleMember, "victim@example.com")

	feed := a.Do(http.MethodPost, "/api/feeds", victimCookie, map[string]any{
		"babyId":   babyID,
		"time":     time.Now().UTC().Format(time.RFC3339),
		"type":     "bottle",
		"amountMl": 111,
	})
	if feed.Status != http.StatusCreated {
		t.Fatalf("seed feed: %d %s", feed.Status, feed.Raw)
	}

	// Self-delete and tombstone-delete are both refused; an unknown id is a
	// 404 rather than a silent success.
	self := a.Do(http.MethodPost, "/api/admin/users/"+adminID+"/delete", cookie, nil)
	if self.Status != http.StatusBadRequest || self.JSON["code"] != "REFUSED" {
		t.Errorf("self-delete = %d %s, want 400 REFUSED", self.Status, self.Raw)
	}
	tomb := a.Do(http.MethodPost, "/api/admin/users/"+db.TombstoneID+"/delete", cookie, nil)
	if tomb.Status != http.StatusBadRequest || tomb.JSON["code"] != "REFUSED" {
		t.Errorf("tombstone delete = %d %s, want 400 REFUSED", tomb.Status, tomb.Raw)
	}
	unknown := a.Do(http.MethodPost, "/api/admin/users/nope/delete", cookie, nil)
	if unknown.Status != http.StatusNotFound || unknown.JSON["code"] != "NOT_FOUND" {
		t.Errorf("unknown delete = %d %s, want 404 NOT_FOUND", unknown.Status, unknown.Raw)
	}

	del := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/delete", cookie, nil)
	if del.Status != http.StatusOK || del.JSON["ok"] != true {
		t.Fatalf("delete = %d %s, want 200 {ok:true}", del.Status, del.Raw)
	}

	assertCount(t, a, `SELECT COUNT(*)::int FROM "users" WHERE "id" = $1`, 0, victimID)
	assertCount(t, a, `SELECT COUNT(*)::int FROM "sessions" WHERE "user_id" = $1`, 0, victimID)
	assertCount(t, a, `SELECT COUNT(*)::int FROM "organization_members" WHERE "user_id" = $1`, 0, victimID)

	// The history survives, attributed to the tombstone.
	feeds := a.DoArray(http.MethodGet, "/api/feeds?babyId="+babyID, cookie, nil)
	if feeds.Status != http.StatusOK || len(feeds.JSON) != 1 {
		t.Fatalf("GET /api/feeds = %d %s", feeds.Status, feeds.Raw)
	}
	kept, _ := feeds.JSON[0].(map[string]any)
	if kept["amountMl"] != float64(111) {
		t.Fatalf("kept feed = %v, want the victim's 111 ml entry", kept)
	}
	if kept["caretakerName"] != "Deleted user" {
		t.Errorf("caretakerName = %v, want %q", kept["caretakerName"], "Deleted user")
	}

	row := findAudit(t, a, "user.delete")
	if row.AdminID != adminID || row.Target != victimID || row.Detail != "victim@example.com" {
		t.Errorf("audit row = %+v, want admin %q target %q detail %q",
			row, adminID, victimID, "victim@example.com")
	}
}

// The four log kinds apps/api/src/routes/admin.ts never grew (play,
// vaccine, vaccine documents, vaccine dismissals) plus the family-invite
// and API-key attributions. Without every branch of
// ReassignUserReferences this delete fails on a foreign-key violation.
func TestAdminDeleteUserCoversEveryAttributionTable(t *testing.T) {
	a, familyID, cookie, _ := sysadminRig(t, "Hansen")
	babyID := a.NewBaby(familyID, "Ada")

	victimID := a.SignUp("Busy caretaker", "victim@example.com")
	victimCookie := a.AddMember(familyID, victimID, auth.RoleAdmin, "victim@example.com")

	now := time.Now().UTC()
	seed := func(path string, body map[string]any) *testrig.Result {
		t.Helper()
		res := a.Do(http.MethodPost, path, victimCookie, body)
		if res.Status != http.StatusCreated {
			t.Fatalf("seed %s: %d %s", path, res.Status, res.Raw)
		}
		return res
	}
	seed("/api/feeds", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "type": "bottle"})
	seed("/api/diapers", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "type": "wet"})
	seed("/api/sleep", map[string]any{"babyId": babyID, "startTime": now.Add(-time.Hour).Format(time.RFC3339), "endTime": now.Format(time.RFC3339)})
	seed("/api/medicine", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "name": "Paracet"})
	seed("/api/baths", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339)})
	seed("/api/notes", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "content": "Slept well"})
	seed("/api/milestones", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "title": "First smile"})
	seed("/api/measurements", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "type": "weight", "value": 4.2})
	seed("/api/pumps", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "amountMl": 60})
	seed("/api/play", map[string]any{"babyId": babyID, "type": "tummy", "startTime": now.Add(-time.Hour).Format(time.RFC3339), "endTime": now.Format(time.RFC3339)})
	vaccine := seed("/api/vaccines", map[string]any{"babyId": babyID, "time": now.Format(time.RFC3339), "name": "Rotavirus"})
	seed("/api/vaccines/dismissals", map[string]any{"babyId": babyID, "slotKey": "6w-rota"})
	seed("/api/invites", map[string]any{"role": "member"})

	// A vaccine document, inserted directly: uploading one needs multipart
	// and object storage, and all this test needs is the uploaded_by FK.
	vaccineID, _ := vaccine.JSON["id"].(string)
	if _, err := a.Rig.Pool.Exec(context.Background(), `
		INSERT INTO "vaccine_document"
			("family_id", "vaccine_log_id", "object_key", "filename",
			 "content_type", "size", "uploaded_by")
		VALUES ($1, $2, 'k', 'card.pdf', 'application/pdf', 1, $3)`,
		familyID, vaccineID, victimID); err != nil {
		t.Fatalf("seed vaccine document: %v", err)
	}

	// An API key the victim minted: it must be revoked, not just reassigned.
	key := a.Do(http.MethodPost, "/api/keys", victimCookie, map[string]any{"name": "Home Assistant"})
	if key.Status != http.StatusCreated {
		t.Fatalf("seed api key: %d %s", key.Status, key.Raw)
	}
	rawKey, _ := key.JSON["key"].(string)

	// An audit row of their own, from before they were deleted.
	makeSysadmin(t, a, victimID)
	note := a.Do(http.MethodPost, "/api/admin/audit", victimCookie, map[string]any{
		"action": "manual.note", "target": "something",
	})
	if note.Status != http.StatusOK {
		t.Fatalf("seed audit note: %d %s", note.Status, note.Raw)
	}

	del := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/delete", cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("delete = %d %s, want 200", del.Status, del.Raw)
	}

	// Every attribution now points at the tombstone; nothing was dropped.
	for _, table := range []struct{ name, column string }{
		{"feed_log", "caretaker_id"},
		{"diaper_log", "caretaker_id"},
		{"sleep_log", "caretaker_id"},
		{"medicine_log", "caretaker_id"},
		{"bath_log", "caretaker_id"},
		{"note_log", "caretaker_id"},
		{"milestone_log", "caretaker_id"},
		{"measurement_log", "caretaker_id"},
		{"pump_log", "caretaker_id"},
		{"play_log", "caretaker_id"},
		{"vaccine_log", "caretaker_id"},
		{"vaccine_document", "uploaded_by"},
		{"vaccine_dismissal", "dismissed_by"},
		{"family_invite", "created_by"},
		{"api_key", "created_by"},
		{"admin_audit", "admin_id"},
	} {
		assertCount(t, a,
			fmt.Sprintf(`SELECT COUNT(*)::int FROM %q WHERE %q = $1`, table.name, table.column),
			1, db.TombstoneID)
	}

	// The key is revoked as well as reattributed — a deleted operator's
	// bearer token must stop working.
	assertCount(t, a, `SELECT COUNT(*)::int FROM "api_key" WHERE "revoked_at" IS NOT NULL`, 1)
	used := bearerDo(a, http.MethodGet, "/api/babies", rawKey, nil)
	if used.Status != http.StatusUnauthorized || used.JSON["code"] != "INVALID_KEY" {
		t.Errorf("deleted user's key = %d %s, want 401 INVALID_KEY", used.Status, used.Raw)
	}
}

// admin.test.ts's "deletes a user who created and was assigned to a calendar
// event (calendar FKs)".
func TestAdminDeleteUserKeepsCalendarEventDropsAssignment(t *testing.T) {
	a, familyID, cookie, _ := sysadminRig(t, "Calendar admin family")

	victimID := a.SignUp("Calendar victim", "victim@example.com")
	victimCookie := a.AddMember(familyID, victimID, auth.RoleMember, "victim@example.com")

	created := a.Do(http.MethodPost, "/api/calendar/events", victimCookie, map[string]any{
		"title":           "Doctor checkup",
		"startTime":       time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339),
		"assigneeUserIds": []string{victimID},
	})
	if created.Status != http.StatusCreated {
		t.Fatalf("create event: %d %s", created.Status, created.Raw)
	}
	eventID, _ := created.JSON["id"].(string)

	del := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/delete", cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("delete = %d %s, want 200", del.Status, del.Raw)
	}

	var createdBy string
	if err := a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "created_by" FROM "calendar_event" WHERE "id" = $1`, eventID).Scan(&createdBy); err != nil {
		t.Fatalf("event row: %v", err)
	}
	if createdBy != db.TombstoneID {
		t.Errorf("createdBy = %q, want the tombstone", createdBy)
	}
	assertCount(t, a, `SELECT COUNT(*)::int FROM "calendar_assignee" WHERE "event_id" = $1`, 0, eventID)
}

// Deleting the caretaker who CREATED a family must not take the family with
// them. Limen ships an organizations.user_id creator column with ON DELETE
// CASCADE that would do exactly that; 00002_limen_align.sql drops it, and
// this test is the guard on that staying true — reintroducing the column
// without adding it to ReassignUserReferences would turn an account deletion
// into a silent family deletion.
func TestAdminDeleteUserKeepsTheFamilyTheyCreated(t *testing.T) {
	a, _, cookie, _ := sysadminRig(t, "Admin family")

	victimFamilyID, victimCookie := a.NewFamily("Victim family", "victim@example.com")
	victimID := userIDByEmail(t, a, "victim@example.com")
	babyID := a.NewBaby(victimFamilyID, "Ada")
	feed := a.Do(http.MethodPost, "/api/feeds", victimCookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if feed.Status != http.StatusCreated {
		t.Fatalf("seed feed: %d %s", feed.Status, feed.Raw)
	}

	del := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/delete", cookie, nil)
	if del.Status != http.StatusOK {
		t.Fatalf("delete = %d %s, want 200", del.Status, del.Raw)
	}

	assertCount(t, a, `SELECT COUNT(*)::int FROM "organizations" WHERE "id" = $1`, 1, victimFamilyID)
	assertCount(t, a, `SELECT COUNT(*)::int FROM "baby" WHERE "family_id" = $1`, 1, victimFamilyID)
	assertCount(t, a, `SELECT COUNT(*)::int FROM "feed_log" WHERE "family_id" = $1`, 1, victimFamilyID)
}

// -----------------------------------------------------------------------
// Audit note
// -----------------------------------------------------------------------

func TestAdminAuditNoteIsRecordedAndListed(t *testing.T) {
	a, _, cookie, adminID := sysadminRig(t, "Hansen")

	res := a.Do(http.MethodPost, "/api/admin/audit", cookie, map[string]any{
		"action": "support.call",
		"target": "ticket-42",
		"detail": "Reset the parent's password over the phone",
	})
	if res.Status != http.StatusOK || res.JSON["ok"] != true {
		t.Fatalf("POST /api/admin/audit = %d %s", res.Status, res.Raw)
	}

	row := findAudit(t, a, "support.call")
	if row.AdminID != adminID || row.Target != "ticket-42" {
		t.Errorf("audit row = %+v", row)
	}

	list := a.DoArray(http.MethodGet, "/api/admin/audit", cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("GET /api/admin/audit = %d %s", list.Status, list.Raw)
	}
	entry, _ := list.JSON[0].(map[string]any)
	if entry["detail"] != "Reset the parent's password over the phone" {
		t.Errorf("detail = %v", entry["detail"])
	}

	// A note over the length limits is a validation failure, not a row.
	long := a.Do(http.MethodPost, "/api/admin/audit", cookie, map[string]any{
		"action": strings.Repeat("x", 61),
		"target": "ticket-43",
	})
	if long.Status != http.StatusBadRequest || long.JSON["code"] != "VALIDATION" {
		t.Errorf("over-long action = %d %s, want 400 VALIDATION", long.Status, long.Raw)
	}
}

// -----------------------------------------------------------------------
// User support surface (NEW in Go)
// -----------------------------------------------------------------------

func TestAdminListUsersFiltersAndLimits(t *testing.T) {
	a, familyID, cookie, _ := sysadminRig(t, "Hansen")
	bo := a.SignUp("Bo Berg", "bo@example.com")
	a.AddMember(familyID, bo, auth.RoleMember, "bo@example.com")
	a.SignUp("Cleo Dahl", "cleo@elsewhere.test")

	all := a.DoArray(http.MethodGet, "/api/admin/users", cookie, nil)
	if all.Status != http.StatusOK {
		t.Fatalf("GET /api/admin/users = %d %s", all.Status, all.Raw)
	}
	// Three accounts plus the tombstone.
	if len(all.JSON) != 4 {
		t.Fatalf("users = %v, want 4 rows", all.JSON)
	}

	byName := a.DoArray(http.MethodGet, "/api/admin/users?query=berg", cookie, nil)
	if len(byName.JSON) != 1 {
		t.Fatalf("query=berg = %v, want 1 row", byName.JSON)
	}
	row, _ := byName.JSON[0].(map[string]any)
	if row["id"] != bo || row["email"] != "bo@example.com" || row["name"] != "Bo Berg" {
		t.Errorf("row = %v, want Bo's account", row)
	}
	if row["banned"] != false || row["banReason"] != nil || row["role"] != nil {
		t.Errorf("row = %v, want banned:false banReason:null role:null", row)
	}

	byEmail := a.DoArray(http.MethodGet, "/api/admin/users?query=elsewhere.test", cookie, nil)
	if len(byEmail.JSON) != 1 {
		t.Errorf("query=elsewhere.test = %v, want 1 row", byEmail.JSON)
	}

	none := a.DoArray(http.MethodGet, "/api/admin/users?query=nobody", cookie, nil)
	if len(none.JSON) != 0 {
		t.Errorf("query=nobody = %v, want no rows", none.JSON)
	}

	limited := a.DoArray(http.MethodGet, "/api/admin/users?limit=2", cookie, nil)
	if len(limited.JSON) != 2 {
		t.Errorf("limit=2 = %v, want 2 rows", limited.JSON)
	}
}

func TestAdminBanKillsSessionsAndAPIKeysUnbanRestores(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")

	victimID := a.SignUp("Noisy caretaker", "victim@example.com")
	victimCookie := a.AddMember(familyID, victimID, auth.RoleMember, "victim@example.com")
	key := a.CreateAPIKey(familyID, victimID)

	// Both credentials work before the ban.
	if res := a.Do(http.MethodGet, "/api/me", victimCookie, nil); res.Status != http.StatusOK {
		t.Fatalf("pre-ban /api/me = %d %s", res.Status, res.Raw)
	}
	if res := bearerDo(a, http.MethodGet, "/api/babies", key, nil); res.Status != http.StatusOK {
		t.Fatalf("pre-ban key = %d %s", res.Status, res.Raw)
	}

	ban := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/ban", cookie, map[string]any{
		"reason": "spamming the family",
	})
	if ban.Status != http.StatusOK || ban.JSON["ok"] != true {
		t.Fatalf("ban = %d %s", ban.Status, ban.Raw)
	}

	// The session is gone (revoked), and the key stops authenticating —
	// otherwise a ban would leave a banned user a working bearer token.
	if res := a.Do(http.MethodGet, "/api/me", victimCookie, nil); res.Status != http.StatusUnauthorized {
		t.Errorf("post-ban /api/me = %d %s, want 401", res.Status, res.Raw)
	}
	assertCount(t, a, `SELECT COUNT(*)::int FROM "sessions" WHERE "user_id" = $1`, 0, victimID)
	if res := bearerDo(a, http.MethodGet, "/api/babies", key, nil); res.Status != http.StatusUnauthorized || res.JSON["code"] != "INVALID_KEY" {
		t.Errorf("post-ban key = %d %s, want 401 INVALID_KEY", res.Status, res.Raw)
	}

	// A fresh sign-in gets no usable session either. Limen's own credential
	// route still answers 200 (nothing there reads our `banned` column), but
	// the session it mints resolves to "signed out" for every route in this
	// API — auth.SessionFromRequest treats a banned account exactly like an
	// absent one. Asserting the downstream effect rather than the sign-in
	// status code is the assertion that matters.
	fresh := signInWith(t, a, "victim@example.com", "Testrig-password-123")
	if fresh.Status == http.StatusOK {
		if res := a.Do(http.MethodGet, "/api/me", sessionCookieFrom(t, fresh), nil); res.Status != http.StatusUnauthorized {
			t.Errorf("banned user's fresh session /api/me = %d %s, want 401", res.Status, res.Raw)
		}
	}

	listed := a.DoArray(http.MethodGet, "/api/admin/users?query=victim@example.com", cookie, nil)
	row, _ := listed.JSON[0].(map[string]any)
	if row["banned"] != true || row["banReason"] != "spamming the family" {
		t.Errorf("listed row = %v, want banned with the reason", row)
	}

	banRow := findAudit(t, a, "user.ban")
	if banRow.AdminID != adminID || banRow.Target != victimID {
		t.Errorf("ban audit = %+v", banRow)
	}

	// An admin may not ban themselves out of the console.
	self := a.Do(http.MethodPost, "/api/admin/users/"+adminID+"/ban", cookie, nil)
	if self.Status != http.StatusBadRequest || self.JSON["code"] != "REFUSED" {
		t.Errorf("self-ban = %d %s, want 400 REFUSED", self.Status, self.Raw)
	}
	if missing := a.Do(http.MethodPost, "/api/admin/users/nope/ban", cookie, nil); missing.Status != http.StatusNotFound {
		t.Errorf("ban unknown user = %d %s, want 404", missing.Status, missing.Raw)
	}

	unban := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/unban", cookie, nil)
	if unban.Status != http.StatusOK || unban.JSON["ok"] != true {
		t.Fatalf("unban = %d %s", unban.Status, unban.Raw)
	}
	if res := signInWith(t, a, "victim@example.com", "Testrig-password-123"); res.Status != http.StatusOK {
		t.Errorf("post-unban sign-in = %d %s, want 200", res.Status, res.Raw)
	}
	if res := bearerDo(a, http.MethodGet, "/api/babies", key, nil); res.Status != http.StatusOK {
		t.Errorf("post-unban key = %d %s, want 200", res.Status, res.Raw)
	}
	listed = a.DoArray(http.MethodGet, "/api/admin/users?query=victim@example.com", cookie, nil)
	row, _ = listed.JSON[0].(map[string]any)
	if row["banned"] != false || row["banReason"] != nil {
		t.Errorf("listed row = %v, want banned:false with no reason", row)
	}
	if unbanRow := findAudit(t, a, "user.unban"); unbanRow.Target != victimID {
		t.Errorf("unban audit = %+v", unbanRow)
	}
	if missing := a.Do(http.MethodPost, "/api/admin/users/nope/unban", cookie, nil); missing.Status != http.StatusNotFound {
		t.Errorf("unban unknown user = %d %s, want 404", missing.Status, missing.Raw)
	}
}

func TestAdminSetPasswordAndRevokeSessions(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")

	victimID := a.SignUp("Forgetful parent", "victim@example.com")
	victimCookie := a.AddMember(familyID, victimID, auth.RoleMember, "victim@example.com")

	revoke := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/sessions/revoke", cookie, nil)
	if revoke.Status != http.StatusOK || revoke.JSON["ok"] != true {
		t.Fatalf("revoke = %d %s", revoke.Status, revoke.Raw)
	}
	if res := a.Do(http.MethodGet, "/api/me", victimCookie, nil); res.Status != http.StatusUnauthorized {
		t.Errorf("revoked session /api/me = %d %s, want 401", res.Status, res.Raw)
	}
	if row := findAudit(t, a, "user.sessions.revoke"); row.AdminID != adminID || row.Target != victimID {
		t.Errorf("revoke audit = %+v", row)
	}

	const newPassword = "brand-new-password-9"
	set := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/password", cookie, map[string]any{
		"password": newPassword,
	})
	if set.Status != http.StatusOK || set.JSON["ok"] != true {
		t.Fatalf("set password = %d %s", set.Status, set.Raw)
	}
	signedIn := signInWith(t, a, "victim@example.com", newPassword)
	if signedIn.Status != http.StatusOK {
		t.Fatalf("sign-in with the new password = %d %s, want 200", signedIn.Status, signedIn.Raw)
	}
	newCookie := sessionCookieFrom(t, signedIn)

	// A second reset revokes the session that first one produced: a password
	// change is either a recovery or a response to a compromise, and both
	// want the old sessions gone (auth.Service.SetPassword).
	again := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/password", cookie, map[string]any{
		"password": newPassword + "-again",
	})
	if again.Status != http.StatusOK {
		t.Fatalf("second set password = %d %s", again.Status, again.Raw)
	}
	if res := a.Do(http.MethodGet, "/api/me", newCookie, nil); res.Status != http.StatusUnauthorized {
		t.Errorf("session after a password reset = %d %s, want 401", res.Status, res.Raw)
	}

	// The password itself must never reach the trail.
	row := findAudit(t, a, "user.password.set")
	if row.AdminID != adminID || row.Target != victimID {
		t.Errorf("password audit = %+v", row)
	}
	for _, entry := range auditRows(t, a) {
		if strings.Contains(entry.Detail, newPassword) || strings.Contains(entry.Target, newPassword) {
			t.Fatalf("the audit trail recorded the password: %+v", entry)
		}
	}

	// Too short is a spec-validation failure, not a stored password.
	short := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/password", cookie, map[string]any{
		"password": "short",
	})
	if short.Status != http.StatusBadRequest || short.JSON["code"] != "VALIDATION" {
		t.Errorf("short password = %d %s, want 400 VALIDATION", short.Status, short.Raw)
	}
	if missing := a.Do(http.MethodPost, "/api/admin/users/nope/password", cookie, map[string]any{
		"password": newPassword,
	}); missing.Status != http.StatusNotFound {
		t.Errorf("password for an unknown user = %d %s, want 404", missing.Status, missing.Raw)
	}
	if missing := a.Do(http.MethodPost, "/api/admin/users/nope/sessions/revoke", cookie, nil); missing.Status != http.StatusNotFound {
		t.Errorf("revoke for an unknown user = %d %s, want 404", missing.Status, missing.Raw)
	}
}

// -----------------------------------------------------------------------
// Impersonation
// -----------------------------------------------------------------------

func TestAdminImpersonationRoundTrip(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")
	babyID := a.NewBaby(familyID, "Ada")

	victimID := a.SignUp("Confused parent", "victim@example.com")
	a.AddMember(familyID, victimID, auth.RoleMember, "victim@example.com")

	start := a.Do(http.MethodPost, "/api/admin/users/"+victimID+"/impersonate", cookie, nil)
	if start.Status != http.StatusOK || start.JSON["ok"] != true {
		t.Fatalf("impersonate = %d %s", start.Status, start.Raw)
	}
	impersonated := sessionCookieFrom(t, start)

	me := a.Do(http.MethodGet, "/api/me", impersonated, nil)
	if me.Status != http.StatusOK {
		t.Fatalf("impersonated /api/me = %d %s", me.Status, me.Raw)
	}
	if me.JSON["userId"] != victimID {
		t.Errorf("userId = %v, want the target %q", me.JSON["userId"], victimID)
	}
	if me.JSON["impersonatedBy"] != adminID {
		t.Errorf("impersonatedBy = %v, want the admin %q", me.JSON["impersonatedBy"], adminID)
	}
	if row := findAudit(t, a, "user.impersonate"); row.AdminID != adminID || row.Target != victimID {
		t.Errorf("impersonate audit = %+v, want the REAL admin as admin_id", row)
	}

	// A write made while impersonating leaves a trail carrying both
	// identities (middleware.RequireFamily; proven in isolation by Task 6's
	// middleware tests, asserted once here end to end).
	if err := a.Deps.Auth.SetActiveFamily(context.Background(), tokenOf(impersonated), familyID); err != nil {
		t.Fatalf("SetActiveFamily on the impersonated session: %v", err)
	}
	write := a.Do(http.MethodPost, "/api/feeds", impersonated, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if write.Status != http.StatusCreated {
		t.Fatalf("impersonated write = %d %s", write.Status, write.Raw)
	}
	if row := findAudit(t, a, "impersonated.write"); row.AdminID != adminID || row.Target != victimID {
		t.Errorf("impersonated.write audit = %+v", row)
	}

	stop := a.Do(http.MethodPost, "/api/admin/stop-impersonating", impersonated, nil)
	if stop.Status != http.StatusOK || stop.JSON["ok"] != true {
		t.Fatalf("stop-impersonating = %d %s", stop.Status, stop.Raw)
	}
	restored := sessionCookieFrom(t, stop)

	back := a.Do(http.MethodGet, "/api/me", restored, nil)
	if back.Status != http.StatusOK || back.JSON["userId"] != adminID {
		t.Fatalf("restored /api/me = %d %s, want the admin", back.Status, back.Raw)
	}
	if back.JSON["impersonatedBy"] != nil {
		t.Errorf("impersonatedBy = %v, want null once restored", back.JSON["impersonatedBy"])
	}
	// The impersonated session is revoked, not merely abandoned.
	if dead := a.Do(http.MethodGet, "/api/me", impersonated, nil); dead.Status != http.StatusUnauthorized {
		t.Errorf("old impersonated session = %d %s, want 401", dead.Status, dead.Raw)
	}
	if row := findAudit(t, a, "impersonation.stop"); row.AdminID != adminID || row.Target != victimID {
		t.Errorf("impersonation.stop audit = %+v, want the REAL admin as admin_id", row)
	}
}

func TestAdminImpersonateRefusesSelfBannedAndUnknown(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")

	bannedID := a.SignUp("Banned parent", "banned@example.com")
	a.AddMember(familyID, bannedID, auth.RoleMember, "banned@example.com")
	if ban := a.Do(http.MethodPost, "/api/admin/users/"+bannedID+"/ban", cookie, nil); ban.Status != http.StatusOK {
		t.Fatalf("ban = %d %s", ban.Status, ban.Raw)
	}

	self := a.Do(http.MethodPost, "/api/admin/users/"+adminID+"/impersonate", cookie, nil)
	if self.Status != http.StatusBadRequest || self.JSON["code"] != "REFUSED" {
		t.Errorf("self-impersonate = %d %s, want 400 REFUSED", self.Status, self.Raw)
	}
	banned := a.Do(http.MethodPost, "/api/admin/users/"+bannedID+"/impersonate", cookie, nil)
	if banned.Status != http.StatusBadRequest || banned.JSON["code"] != "REFUSED" {
		t.Errorf("impersonate a banned user = %d %s, want 400 REFUSED", banned.Status, banned.Raw)
	}
	unknown := a.Do(http.MethodPost, "/api/admin/users/nope/impersonate", cookie, nil)
	if unknown.Status != http.StatusNotFound || unknown.JSON["code"] != "NOT_FOUND" {
		t.Errorf("impersonate an unknown user = %d %s, want 404 NOT_FOUND", unknown.Status, unknown.Raw)
	}
}

// POST /api/admin/stop-impersonating is deliberately session-level rather
// than sysadmin-gated (see its spec summary): while impersonating an
// ordinary user the current session IS that user's, so a sysadmin gate would
// trap the operator inside it. An ordinary caller therefore reaches the
// route, and gets a 400 rather than a 403 — the only thing they can do here.
func TestStopImpersonatingIsReachableWithoutTheAdminRole(t *testing.T) {
	a := testrig.App(t)
	_, cookie := a.NewFamily("Hansen", "parent@example.com")

	res := a.Do(http.MethodPost, "/api/admin/stop-impersonating", cookie, nil)
	if res.Status != http.StatusBadRequest || res.JSON["code"] != "NOT_IMPERSONATING" {
		t.Errorf("stop-impersonating as an ordinary user = %d %s, want 400 NOT_IMPERSONATING",
			res.Status, res.Raw)
	}

	anon := a.Do(http.MethodPost, "/api/admin/stop-impersonating", "", nil)
	if anon.Status != http.StatusUnauthorized {
		t.Errorf("anonymous stop-impersonating = %d %s, want 401", anon.Status, anon.Raw)
	}
}

// One sysadmin impersonating another can reach the admin console with the
// impersonated session (an ordinary target's session would fail
// RequireSysadmin). Two things must hold there: the audit trail names the
// REAL operator, not the colleague whose session is being driven, and the
// impersonation cannot be chained.
func TestAdminActionsUnderImpersonationNameTheRealOperator(t *testing.T) {
	a, familyID, cookie, adminID := sysadminRig(t, "Hansen")

	colleagueID := a.SignUp("Second admin", "second@example.com")
	a.AddMember(familyID, colleagueID, auth.RoleAdmin, "second@example.com")
	makeSysadmin(t, a, colleagueID)
	bystanderID := a.SignUp("Bystander", "bystander@example.com")

	start := a.Do(http.MethodPost, "/api/admin/users/"+colleagueID+"/impersonate", cookie, nil)
	if start.Status != http.StatusOK {
		t.Fatalf("impersonate = %d %s", start.Status, start.Raw)
	}
	impersonated := sessionCookieFrom(t, start)

	note := a.Do(http.MethodPost, "/api/admin/audit", impersonated, map[string]any{
		"action": "support.note", "target": "ticket-7",
	})
	if note.Status != http.StatusOK {
		t.Fatalf("audit note while impersonating = %d %s", note.Status, note.Raw)
	}
	if row := findAudit(t, a, "support.note"); row.AdminID != adminID {
		t.Errorf("audit admin_id = %q, want the real operator %q (not the impersonated admin %q)",
			row.AdminID, adminID, colleagueID)
	}

	chained := a.Do(http.MethodPost, "/api/admin/users/"+bystanderID+"/impersonate", impersonated, nil)
	if chained.Status != http.StatusBadRequest || chained.JSON["code"] != "REFUSED" {
		t.Errorf("chained impersonation = %d %s, want 400 REFUSED", chained.Status, chained.Raw)
	}
}

// -----------------------------------------------------------------------
// Schema guard
// -----------------------------------------------------------------------

// reassignedUserReferences is every non-cascading foreign key to "users"
// that queries/admin.sql's ReassignUserReferences points at the tombstone,
// plus the one it deletes instead (calendar_assignee — an assignment is not
// an attribution).
var reassignedUserReferences = map[string]string{
	"sleep_log":         "caretaker_id",
	"feed_log":          "caretaker_id",
	"diaper_log":        "caretaker_id",
	"medicine_log":      "caretaker_id",
	"bath_log":          "caretaker_id",
	"note_log":          "caretaker_id",
	"milestone_log":     "caretaker_id",
	"measurement_log":   "caretaker_id",
	"pump_log":          "caretaker_id",
	"play_log":          "caretaker_id",
	"vaccine_log":       "caretaker_id",
	"vaccine_document":  "uploaded_by",
	"vaccine_dismissal": "dismissed_by",
	"family_invite":     "created_by",
	"api_key":           "created_by",
	"admin_audit":       "admin_id",
	"calendar_event":    "created_by",
	"calendar_assignee": "user_id",
}

// A migration that adds a new non-cascading reference to "users" — another
// log kind, another attributed table — would break POST
// /api/admin/users/{id}/delete with a foreign-key violation, and nothing
// else in the suite would notice until somebody tried to delete an account
// that happened to have such a row. This asks the live schema instead of
// trusting the enumeration: every NO ACTION / RESTRICT reference to users
// must be one ReassignUserReferences handles.
//
// Rows with ON DELETE CASCADE are deliberately not listed: the account
// taking them with it (sessions, memberships, push subscriptions) is the
// correct behaviour, not an omission.
func TestUserDeleteCoversEveryNonCascadingUserReference(t *testing.T) {
	a := testrig.App(t)

	rows, err := a.Rig.Pool.Query(context.Background(), `
		SELECT c.conrelid::regclass::text, att."attname"
		FROM "pg_constraint" c
		JOIN unnest(c.conkey) WITH ORDINALITY AS k("attnum", "ord") ON true
		JOIN "pg_attribute" att ON att."attrelid" = c.conrelid AND att."attnum" = k."attnum"
		WHERE c.contype = 'f'
		  AND c.confrelid = 'users'::regclass
		  AND c.confdeltype IN ('a', 'r')`)
	if err != nil {
		t.Fatalf("read foreign keys: %v", err)
	}
	defer rows.Close()

	found := map[string]string{}
	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatalf("scan foreign key: %v", err)
		}
		found[table] = column
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read foreign keys: %v", err)
	}

	for table, column := range found {
		want, ok := reassignedUserReferences[table]
		if !ok {
			t.Errorf("%s.%s references users with no cascade and is NOT handled by "+
				"ReassignUserReferences — add a branch there (or a DELETE, if it is an "+
				"assignment rather than an attribution) or account deletion will fail on it",
				table, column)
			continue
		}
		if want != column {
			t.Errorf("%s references users through %q, but ReassignUserReferences handles %q",
				table, column, want)
		}
	}
	for table := range reassignedUserReferences {
		if _, ok := found[table]; !ok {
			t.Errorf("ReassignUserReferences handles %q, which no longer has a "+
				"non-cascading foreign key to users — stale branch", table)
		}
	}
}
