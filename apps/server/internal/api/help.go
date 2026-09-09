package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
	"github.com/refsdal/pjokk/server/internal/ratelimit"
)

// Help requests — docs/superpowers/specs/2026-09-06-help-request-design.md.
// The first feature designed after the Go migration, so unlike its
// neighbours this file ports nothing.
//
// A request is family STATE (compare sleep.go's running session), read
// through GET /api/summary's openHelp (summary.go) and written here. Three
// things worth knowing before editing:
//
//   - Every operation is tierFamilyNoAPIKey (api.go): the push says who is
//     asking, and a pjk_ key has no person behind it.
//   - The rate limit is per USER and lives in this file, not in api.go's
//     rateLimitChain: middleware.RateLimit keys on the client address and
//     runs before the session is resolved, and a household shares one
//     address — the thing to slow down is one person pinging another.
//   - A push failure never fails the request. The row is committed first,
//     then the push is attempted, and the response's `delivered` tells the
//     sender whether anything reached a device (the SPA turns 0 into
//     "<name> hasn't turned on notifications").

const (
	// helpRequestWindow is how long after creation a request is still
	// returned by NewestHelpRequest (summary.go). Expiry is a read-side
	// filter — nothing has to fire for a request to disappear.
	helpRequestWindow = 2 * time.Hour

	helpRateLimit         = 5
	helpRateWindowSeconds = 300

	// helpDefaultBody is the push body when the sender typed nothing.
	helpDefaultBody = "Can you come?"
	// helpNameless stands in for a user with no display name in push titles.
	helpNameless = "Someone"
)

// hitUserLimit charges one request against a per-user bucket and reports
// whether the caller is now over limit. Same key shape and wall-clock window
// as middleware.RateLimit (rl:<name>:<bucket>:<window>), so the nightly
// Sweep prunes both alike; the bucket is the user id rather than an address
// digest. Kept generic (name/limit/window are parameters) so the next
// per-user limit reuses it instead of growing a second copy.
func hitUserLimit(ctx context.Context, store ratelimit.Store, name, userID string, limit, windowSeconds int) (bool, error) {
	window := time.Now().Unix() / int64(windowSeconds)
	key := fmt.Sprintf("rl:%s:%s:%d", name, userID, window)
	count, err := store.Hit(ctx, key, windowSeconds)
	if err != nil {
		return false, err
	}
	return count > limit, nil
}

// serHelpRequestRow converts one joined help_request row into the wire
// shape. GetHelpRequest and NewestHelpRequest produce structurally identical
// rows under different generated names (see help.sql), hence the flat
// parameter list and the two thin wrappers below — play.go's arrangement.
// acknowledgedByName is only meaningful once acknowledged: the query
// COALESCEs it to ” in both the "nobody yet" and the "nameless answerer"
// cases, and acknowledgedAt is what tells them apart.
// serHelpRequest converts one help_request row into the wire shape.
// GetHelpRequest and NewestHelpRequest produce two names for this one
// shape; GetSummary's openHelp holds the latter and converts (see
// convert.go). delivered is not a column — it is how many devices the push
// actually reached, which only the sending path knows; a read passes 0.
func serHelpRequest(row dbgen.GetHelpRequestRow, delivered int) gen.HelpRequest {
	out := gen.HelpRequest{
		Id:             row.ID,
		FromUserId:     row.FromUserID,
		FromName:       row.FromName,
		ToUserId:       row.ToUserID,
		ToName:         row.ToName,
		Message:        row.Message,
		CreatedAt:      row.CreatedAt.Time,
		AcknowledgedAt: tsPtr(row.AcknowledgedAt),
		Delivered:      delivered,
	}
	if row.AcknowledgedAt.Valid {
		name := row.AcknowledgedByName
		out.AcknowledgedByName = &name
	}
	return out
}

func displayName(name string) string {
	if name == "" {
		return helpNameless
	}
	return name
}

// CreateHelpRequest implements POST /api/help.
func (d Deps) CreateHelpRequest(ctx context.Context, req gen.CreateHelpRequestRequestObject) (gen.CreateHelpRequestResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateHelpRequest")
	}
	body := req.Body

	// Charged before validation, like the middleware limiter: a burst of
	// bad requests is still a burst.
	over, err := hitUserLimit(ctx, d.RateLimit, "help", fam.UserID, helpRateLimit, helpRateWindowSeconds)
	if err != nil {
		return nil, err
	}
	if over {
		return gen.CreateHelpRequest429JSONResponse{Error: "Too many requests, wait a few minutes", Code: "RATE_LIMITED"}, nil
	}

	toUserID, err := d.Q.GetMembershipUser(ctx, dbgen.GetMembershipUserParams{OrganizationID: fam.FamilyID, ID: body.MemberId})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.CreateHelpRequest404JSONResponse{Error: "No such member", Code: "MEMBER_NOT_FOUND"}, nil
		}
		return nil, err
	}
	if toUserID == fam.UserID {
		return gen.CreateHelpRequest400JSONResponse{Error: "You cannot ask yourself", Code: "SELF_HELP"}, nil
	}

	message := ""
	if body.Message != nil {
		message = strings.TrimSpace(*body.Message)
	}

	id, err := d.Q.CreateHelpRequest(ctx, dbgen.CreateHelpRequestParams{
		FamilyID:   fam.FamilyID,
		FromUserID: fam.UserID,
		ToUserID:   toUserID,
		Message:    message,
		CreatedAt:  ts(d.Now()),
	})
	if err != nil {
		return nil, err
	}
	row, err := d.Q.GetHelpRequest(ctx, dbgen.GetHelpRequestParams{FamilyID: fam.FamilyID, ID: id})
	if err != nil {
		return nil, err
	}

	pushBody := message
	if pushBody == "" {
		pushBody = helpDefaultBody
	}
	delivered, err := d.Push.ToUser(ctx, toUserID, push.PushPayload{
		Title: displayName(row.FromName) + " needs a hand",
		Body:  pushBody,
		URL:   "/home",
	})
	if err != nil {
		// The row is already committed and the card will show regardless.
		// The count is kept rather than zeroed so a Sender that reports
		// partial success (e.g. delivered to some of several subscriptions
		// before one 410'd) is honoured, and the sender only sees "hasn't
		// turned on notifications" when nothing at all got through. The
		// shipped WebPush.ToUser returns 0 alongside any error today, so
		// this is defensive rather than load-bearing.
		log.Printf("help: push to %s failed: %v", toUserID, err)
	}
	return gen.CreateHelpRequest201JSONResponse(serHelpRequest(row, delivered)), nil
}

// AcknowledgeHelpRequest implements POST /api/help/{id}/acknowledge.
func (d Deps) AcknowledgeHelpRequest(ctx context.Context, req gen.AcknowledgeHelpRequestRequestObject) (gen.AcknowledgeHelpRequestResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	userID := fam.UserID
	changed, err := d.Q.AcknowledgeHelpRequest(ctx, dbgen.AcknowledgeHelpRequestParams{
		FamilyID:       fam.FamilyID,
		ID:             req.Id,
		AcknowledgedAt: ts(d.Now()),
		AcknowledgedBy: &userID,
	})
	if err != nil {
		return nil, err
	}
	// Zero rows is either "already acknowledged" (idempotent, fall through
	// and return it) or "no such request" (404 from the read below).
	row, err := d.Q.GetHelpRequest(ctx, dbgen.GetHelpRequestParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.AcknowledgeHelpRequest404JSONResponse(notFound()), nil
		}
		return nil, err
	}

	if changed == 1 && row.FromUserID != fam.UserID {
		if _, err := d.Push.ToUser(ctx, row.FromUserID, push.PushPayload{
			Title: displayName(row.AcknowledgedByName) + " is on the way",
			Body:  "Answered your request",
			URL:   "/home",
		}); err != nil {
			log.Printf("help: push to %s failed: %v", row.FromUserID, err)
		}
	}
	return gen.AcknowledgeHelpRequest200JSONResponse(serHelpRequest(row, 0)), nil
}

// DeleteHelpRequest implements DELETE /api/help/{id}. Sender or admin only —
// a bystander dismissing someone else's call for help is the one thing this
// feature must not allow.
func (d Deps) DeleteHelpRequest(ctx context.Context, req gen.DeleteHelpRequestRequestObject) (gen.DeleteHelpRequestResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)

	row, err := d.Q.GetHelpRequest(ctx, dbgen.GetHelpRequestParams{FamilyID: fam.FamilyID, ID: req.Id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.DeleteHelpRequest404JSONResponse(notFound()), nil
		}
		return nil, err
	}
	if row.FromUserID != fam.UserID && !middleware.IsAdminRole(fam.MemberRole) {
		return gen.DeleteHelpRequest403JSONResponse{Error: "Only the sender or a family admin can dismiss this", Code: "NOT_SENDER"}, nil
	}
	if _, err := d.Q.DeleteHelpRequest(ctx, dbgen.DeleteHelpRequestParams{FamilyID: fam.FamilyID, ID: req.Id}); err != nil {
		return nil, err
	}
	return gen.DeleteHelpRequest200JSONResponse{Ok: gen.OkOkTrue}, nil
}
