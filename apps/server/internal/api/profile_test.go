package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/testrig"
)

func strp(s string) *string { return &s }

// display_name is a stored generated column: nickname when set (after
// trimming), else the full name. It is the ONE place the rule lives
// (spec §1), so this pins the column itself before any route uses it.
func TestDisplayNameFallsBackToFullName(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	id := a.SignUp("Anders Olsen", "anders@example.com")

	p, err := a.Deps.Q.GetUserProfile(ctx, id)
	if err != nil {
		t.Fatalf("GetUserProfile: %v", err)
	}
	if p.DisplayName != "Anders Olsen" {
		t.Errorf("display_name = %q, want the full name", p.DisplayName)
	}

	if err := a.Deps.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: id, Name: strp("Anders Olsen"), Nickname: strp("Pappa"), Phone: nil,
	}); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	p, _ = a.Deps.Q.GetUserProfile(ctx, id)
	if p.DisplayName != "Pappa" {
		t.Errorf("display_name = %q, want the nickname", p.DisplayName)
	}

	// A blank nickname is no nickname.
	if err := a.Deps.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: id, Name: strp("Anders Olsen"), Nickname: strp("   "), Phone: nil,
	}); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	p, _ = a.Deps.Q.GetUserProfile(ctx, id)
	if p.DisplayName != "Anders Olsen" {
		t.Errorf("display_name after blank nickname = %q, want the full name", p.DisplayName)
	}
}

// TestMarkAvatarImportAttemptedClaimsOnce pins the atomic-claim fix
// (profile.sql's WHERE avatar_imported_at IS NULL AND avatar_key IS NULL
// guard): only the FIRST of several concurrent callers may ever flip a
// user's avatar_imported_at, so importGoogleAvatar's rows==0 branch has
// something real to check.
func TestMarkAvatarImportAttemptedClaimsOnce(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	id := a.SignUp("Google Person", "g2@example.com")

	rows, err := a.Deps.Q.MarkAvatarImportAttempted(ctx, dbgen.MarkAvatarImportAttemptedParams{
		ID:               id,
		AvatarImportedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	})
	if err != nil {
		t.Fatalf("first MarkAvatarImportAttempted: %v", err)
	}
	if rows != 1 {
		t.Errorf("first claim rows = %d, want 1", rows)
	}

	rows, err = a.Deps.Q.MarkAvatarImportAttempted(ctx, dbgen.MarkAvatarImportAttemptedParams{
		ID:               id,
		AvatarImportedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
	})
	if err != nil {
		t.Fatalf("second MarkAvatarImportAttempted: %v", err)
	}
	if rows != 0 {
		t.Errorf("second claim rows = %d, want 0 (already claimed)", rows)
	}
}

// Every attribution join reads display_name, so a nickname shows up as
// caretakerName on the logs the family sees — without the frontend knowing
// the rule.
func TestAttributionUsesDisplayName(t *testing.T) {
	a := testrig.App(t)
	ctx := context.Background()
	familyID, cookie := a.NewFamily("Hansen", "parent@example.com")
	babyID := a.NewBaby(familyID, "Liv")

	res := a.Do(http.MethodPost, "/api/feeds", cookie, map[string]any{
		"babyId": babyID,
		"time":   time.Now().UTC().Format(time.RFC3339),
		"type":   "bottle",
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("create feed: %d %s", res.Status, res.Raw)
	}

	var userID string
	if err := a.Rig.Pool.QueryRow(ctx, `SELECT "id" FROM "users" WHERE "email" = $1`, "parent@example.com").Scan(&userID); err != nil {
		t.Fatalf("user id: %v", err)
	}
	if err := a.Deps.Q.UpdateUserProfile(ctx, dbgen.UpdateUserProfileParams{
		ID: userID, Name: strp("Rig admin"), Nickname: strp("Mamma"), Phone: nil,
	}); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}

	list := a.DoArray(http.MethodGet, "/api/feeds", cookie, nil)
	if list.Status != http.StatusOK || len(list.JSON) != 1 {
		t.Fatalf("list feeds: %d %s", list.Status, list.Raw)
	}
	first := list.JSON[0].(map[string]any)
	if first["caretakerName"] != "Mamma" {
		t.Errorf("caretakerName = %v, want the nickname", first["caretakerName"])
	}

	members := a.DoArray(http.MethodGet, "/api/family/members", cookie, nil)
	if members.Status != http.StatusOK || len(members.JSON) != 1 {
		t.Fatalf("list members: %d %s", members.Status, members.Raw)
	}
	if m := members.JSON[0].(map[string]any); m["name"] != "Mamma" {
		t.Errorf("member name = %v, want the nickname", m["name"])
	}
}
