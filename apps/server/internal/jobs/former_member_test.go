package jobs_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/refsdal/pjokk/server/internal/auth"
	"github.com/refsdal/pjokk/server/internal/jobs"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

// Issue #92: a caretaker removed from a family, or banned, must stop
// receiving that family's scheduled pushes — the baby's name, the time
// since the last feed, calendar titles. Two layers: removal deletes the
// person's reminder, snooze and assignee rows for that family, and the
// frequent job's reads skip anyone who is not a current, unbanned member,
// so a row that survives some other way can never deliver.

// formerMember is a family (admin A) with a second caretaker B who has
// every kind of scheduled push waiting at t0+15m: two feed reminders (one
// already fired and snoozed, one not yet fired), a calendar event assigned
// to B alone, and an unassigned event that reminds every member.
type formerMember struct {
	a                 *testrig.AppRig
	familyID          string
	adminCookie       string
	adminID, memberID string
	membershipID      string
	t0                time.Time
}

func newFormerMember(t *testing.T) formerMember {
	t.Helper()
	a := testrig.App(t)
	familyID, adminCookie := a.NewFamily("Hansen", "parent@example.com")
	adminID := userIDByEmail(t, a, "parent@example.com")
	babyID := a.NewBaby(familyID, "Nora")
	subscribePush(t, a, adminCookie, "https://fcm.googleapis.com/former/admin")

	memberID := a.SignUp("Nanny", "nanny@example.com")
	memberCookie := a.AddMember(familyID, memberID, auth.RoleMember, "nanny@example.com")
	subscribePush(t, a, memberCookie, "https://fcm.googleapis.com/former/nanny")

	t0 := time.Now().UTC().Truncate(time.Second)
	logAt(t, a, adminCookie, "/api/feeds", map[string]any{
		"babyId": babyID, "time": t0.Add(-4 * time.Hour).Format(time.RFC3339), "type": "bottle", "amountMl": 100,
	})

	// B's first reminder fires at t0 and B snoozes it: a push_snooze row
	// due at t0+15m.
	addReminder(t, a, memberCookie, feedEvery3h)
	if sent := run(t, a, t0); sent != 1 {
		t.Fatalf("setup: reminder sent = %d, want 1", sent)
	}
	tapSnooze(t, a, a.Push.Sent(memberID)[0], t0.Add(time.Minute))

	// B's second reminder has not fired yet; at t0+15m it would.
	addReminder(t, a, memberCookie, map[string]any{"kind": "feed", "mode": "since_last", "intervalMin": 120, "tz": "UTC"})

	createCalendarEvent(t, a, adminCookie, map[string]any{
		"title":               "Vaccine appointment",
		"startTime":           t0.Add(45 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
		"assigneeUserIds":     []string{memberID},
	})
	createCalendarEvent(t, a, adminCookie, map[string]any{
		"title":               "Family dinner",
		"startTime":           t0.Add(45 * time.Minute).Format(time.RFC3339),
		"remindMinutesBefore": 60,
	})

	f := formerMember{
		a: a, familyID: familyID, adminCookie: adminCookie,
		adminID: adminID, memberID: memberID, t0: t0,
	}
	f.membershipID = f.membership(t)
	if got := f.pushRows(t); got != (pushRows{reminders: 2, snoozes: 1, assignees: 1}) {
		t.Fatalf("setup: B's rows in the family = %+v, want 2 reminders, 1 snooze, 1 assignee", got)
	}
	return f
}

func (f formerMember) membership(t *testing.T) string {
	t.Helper()
	var id string
	if err := f.a.Rig.Pool.QueryRow(context.Background(),
		`SELECT "id" FROM "organization_members" WHERE "organization_id" = $1 AND "user_id" = $2`,
		f.familyID, f.memberID).Scan(&id); err != nil {
		t.Fatalf("membership of B: %v", err)
	}
	return id
}

type pushRows struct{ reminders, snoozes, assignees int }

// pushRows counts B's scheduled-push rows in the fixture's family only.
func (f formerMember) pushRows(t *testing.T) pushRows {
	t.Helper()
	return countPushRows(t, f.a, f.familyID, f.memberID)
}

func countPushRows(t *testing.T, a *testrig.AppRig, familyID, userID string) pushRows {
	t.Helper()
	var r pushRows
	if err := a.Rig.Pool.QueryRow(context.Background(), `
		SELECT
		  (SELECT COUNT(*)::int FROM "reminder" WHERE "family_id" = $1 AND "user_id" = $2),
		  (SELECT COUNT(*)::int FROM "push_snooze" WHERE "family_id" = $1 AND "user_id" = $2),
		  (SELECT COUNT(*)::int FROM "calendar_assignee" ca
		     JOIN "calendar_event" e ON e."id" = ca."event_id"
		    WHERE e."family_id" = $1 AND ca."user_id" = $2)`,
		familyID, userID).Scan(&r.reminders, &r.snoozes, &r.assignees); err != nil {
		t.Fatalf("count push rows: %v", err)
	}
	return r
}

// runFrequent is cron's frequent job (internal/cron's runFrequent), in its
// order, at a chosen moment.
func runFrequent(t *testing.T, a *testrig.AppRig, now time.Time) {
	t.Helper()
	ctx := context.Background()
	d := depsFor(a)
	if _, err := jobs.RunReminders(ctx, d, now); err != nil {
		t.Fatalf("RunReminders: %v", err)
	}
	if _, err := jobs.RunCalendarReminders(ctx, d, now); err != nil {
		t.Fatalf("RunCalendarReminders: %v", err)
	}
	if _, err := jobs.RunSnoozes(ctx, d, now); err != nil {
		t.Fatalf("RunSnoozes: %v", err)
	}
}

// assertOnlyTheFamilyIsReminded runs the frequent job at t0+15m and checks
// B got nothing more while A still got both events — proof the job ran,
// and that the event B was assigned alone now reminds the family, as an
// event with no assignees does.
func (f formerMember) assertOnlyTheFamilyIsReminded(t *testing.T) {
	t.Helper()
	before := f.a.Push.Count(f.memberID)
	runFrequent(t, f.a, f.t0.Add(15*time.Minute))
	if got := f.a.Push.Count(f.memberID) - before; got != 0 {
		for _, p := range f.a.Push.Sent(f.memberID)[before:] {
			t.Logf("delivered to B: %q", p.Body)
		}
		t.Errorf("deliveries to B after the frequent job = %d, want 0", got)
	}
	if got := f.a.Push.Count(f.adminID); got != 2 {
		t.Errorf("deliveries to A = %d, want 2 (both events)", got)
	}
}

func TestRemovedMemberReceivesNoFamilyPushes(t *testing.T) {
	f := newFormerMember(t)
	res := f.a.Do(http.MethodDelete, "/api/family/members/"+f.membershipID, f.adminCookie, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("remove member: status %d, body %s", res.Status, res.Raw)
	}
	f.assertOnlyTheFamilyIsReminded(t)
}

// Defence in depth: a membership that disappears WITHOUT the removal's
// cleanup (a future path, a hand edit) leaves B's rows behind, and the job
// must still not deliver them.
func TestStaleRowsOfAFormerMemberNeverDeliver(t *testing.T) {
	f := newFormerMember(t)
	ctx := context.Background()
	if _, err := f.a.Rig.Pool.Exec(ctx,
		`DELETE FROM "organization_member_roles" WHERE "member_id" = $1`, f.membershipID); err != nil {
		t.Fatalf("drop roles: %v", err)
	}
	if _, err := f.a.Rig.Pool.Exec(ctx,
		`DELETE FROM "organization_members" WHERE "id" = $1`, f.membershipID); err != nil {
		t.Fatalf("drop membership: %v", err)
	}
	f.assertOnlyTheFamilyIsReminded(t)
}

func TestBannedMemberReceivesNoFamilyPushes(t *testing.T) {
	f := newFormerMember(t)
	if _, err := f.a.Rig.Pool.Exec(context.Background(),
		`UPDATE "users" SET "banned" = true WHERE "id" = $1`, f.memberID); err != nil {
		t.Fatalf("ban B: %v", err)
	}
	f.assertOnlyTheFamilyIsReminded(t)
	// The snooze a banned person could not receive is spent, not kept for
	// an unban: it would come back as a stale notification.
	if got := f.pushRows(t).snoozes; got != 0 {
		t.Errorf("B's snoozes after the frequent job = %d, want 0", got)
	}
}

// Both removal paths — the family admin's and the operator console's —
// leave none of B's scheduled-push rows in that family, and touch none of
// B's rows in another family B still belongs to.
func TestRemovingAMemberDeletesTheirPushRowsInThatFamilyOnly(t *testing.T) {
	for _, path := range []struct {
		name   string
		remove func(t *testing.T, f formerMember) *testrig.Result
	}{
		{"family admin", func(t *testing.T, f formerMember) *testrig.Result {
			return f.a.Do(http.MethodDelete, "/api/family/members/"+f.membershipID, f.adminCookie, nil)
		}},
		{"operator console", func(t *testing.T, f formerMember) *testrig.Result {
			operatorID := f.a.SignUp("Operator", "operator@example.com")
			if _, err := f.a.Rig.Pool.Exec(context.Background(),
				`UPDATE "users" SET "role" = 'admin' WHERE "id" = $1`, operatorID); err != nil {
				t.Fatalf("make sysadmin: %v", err)
			}
			return f.a.Do(http.MethodDelete,
				"/api/admin/families/"+f.familyID+"/members/"+f.membershipID, f.a.SignIn("operator@example.com"), nil)
		}},
	} {
		t.Run(path.name, func(t *testing.T) {
			f := newFormerMember(t)

			// B also cares for another family, with rows of their own there.
			otherID, otherCookie := f.a.NewFamily("Berg", "berg@example.com")
			memberCookie := f.a.AddMember(otherID, f.memberID, auth.RoleMember, "nanny@example.com")
			addReminder(t, f.a, memberCookie, feedEvery3h)
			createCalendarEvent(t, f.a, otherCookie, map[string]any{
				"title":               "Swimming",
				"startTime":           f.t0.Add(48 * time.Hour).Format(time.RFC3339),
				"remindMinutesBefore": 60,
				"assigneeUserIds":     []string{f.memberID},
			})
			if _, err := f.a.Rig.Pool.Exec(context.Background(), `
				INSERT INTO "push_snooze" ("family_id", "user_id", "source", "source_id", "sent_at", "due_at")
				VALUES ($1, $2, 'reminder', 'r-elsewhere', $3, $4)`,
				otherID, f.memberID, f.t0, f.t0.Add(time.Hour)); err != nil {
				t.Fatalf("seed snooze elsewhere: %v", err)
			}
			elsewhere := countPushRows(t, f.a, otherID, f.memberID)
			if elsewhere != (pushRows{reminders: 1, snoozes: 1, assignees: 1}) {
				t.Fatalf("setup: B's rows in the other family = %+v", elsewhere)
			}

			if res := path.remove(t, f); res.Status != http.StatusOK {
				t.Fatalf("remove member: status %d, body %s", res.Status, res.Raw)
			}
			if got := f.pushRows(t); got != (pushRows{}) {
				t.Errorf("B's rows left in the family = %+v, want none", got)
			}
			if got := countPushRows(t, f.a, otherID, f.memberID); got != elsewhere {
				t.Errorf("B's rows in the other family = %+v, want %+v untouched", got, elsewhere)
			}
		})
	}
}
