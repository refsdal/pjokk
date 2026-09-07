package api

import (
	"context"
	"net/url"
	"strings"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
	"github.com/refsdal/pjokk/server/internal/push"
)

// This file ports apps/api/src/routes/push.ts (REF §A1 push.ts): the VAPID
// config endpoint, the subscription lifecycle (subscribe/unsubscribe), the
// per-caretaker feed-reminder preference, and a test-send. Every operation
// here is tierFamilyNoAPIKey (api.go's operationAuthTiers) — a push
// subscription is bound to a signed-in BROWSER, not a programmatic pjk_
// bearer caller, matching apps/api/src/app.ts's
// domainBase.use("/api/push/*", rejectApiKey), which is mounted AFTER
// requireFamily: a key resolves fine through auth/tenancy and is refused
// only at this push-specific gate (see push_test.go's
// TestPushRoutesForbidAPIKeyAuth).

// allowedPushHosts is the SSRF guard apps/api/src/routes/push.ts's sec
// review comment (M2) describes: the cron scheduler (a later task) POSTs to
// stored endpoints unattended, so only real browser push services are ever
// accepted as a subscription target.
var allowedPushHosts = []string{
	"fcm.googleapis.com",        // Chrome/Chromium
	"push.apple.com",            // Safari / iOS
	"push.services.mozilla.com", // Firefox
	"mozaws.net",                // Firefox (legacy autopush)
	"notify.windows.com",        // Edge (WNS)
}

// isAllowedPushEndpoint reports whether endpoint is a syntactically valid
// https: URL whose host is one of allowedPushHosts or a subdomain of one.
// Port of apps/api/src/routes/push.ts's isAllowedPushEndpoint: the TS
// version anchors its regex on `(^|\.)host$`, i.e. an exact match or a
// match preceded by a dot — never a plain substring check, which is why
// "fcm.googleapis.com.evil.com" (the allowed host as a PREFIX of the real,
// malicious one) does not match here either.
func isAllowedPushEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	for _, allowed := range allowedPushHosts {
		if host == allowed || strings.HasSuffix(host, "."+allowed) {
			return true
		}
	}
	return false
}

// GetPushConfig implements GET /api/push/config. REF: "{publicKey}".
func (d Deps) GetPushConfig(_ context.Context, _ gen.GetPushConfigRequestObject) (gen.GetPushConfigResponseObject, error) {
	return gen.GetPushConfig200JSONResponse{PublicKey: d.VAPIDPublicKey}, nil
}

// SubscribePush implements POST /api/push/subscribe. REF: "{endpoint,
// p256dh, auth} → {ok:true}; 400 BAD_ENDPOINT unless https and the host is
// allowlisted. Upserts by endpoint — re-subscribing rebinds it to the
// calling user/family and refreshes its keys" (UpsertPushSubscription's
// ON CONFLICT ("endpoint") DO UPDATE).
func (d Deps) SubscribePush(ctx context.Context, req gen.SubscribePushRequestObject) (gen.SubscribePushResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("SubscribePush")
	}
	body := req.Body

	if !isAllowedPushEndpoint(body.Endpoint) {
		return gen.SubscribePush400JSONResponse{Error: "Unrecognized push service", Code: "BAD_ENDPOINT"}, nil
	}

	if err := d.Q.UpsertPushSubscription(ctx, dbgen.UpsertPushSubscriptionParams{
		FamilyID: fam.FamilyID,
		UserID:   fam.UserID,
		Endpoint: body.Endpoint,
		P256dh:   body.P256dh,
		Auth:     body.Auth,
	}); err != nil {
		return nil, err
	}
	return gen.SubscribePush200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// UnsubscribePush implements POST /api/push/unsubscribe. REF: "{endpoint} →
// {ok:true} (deletes only OWN rows — user-scoped)". Removing an endpoint
// that isn't the caller's, or doesn't exist at all, is still 200: this is a
// set-membership operation ("make sure this endpoint isn't registered to
// me"), not a lookup that can 404.
func (d Deps) UnsubscribePush(ctx context.Context, req gen.UnsubscribePushRequestObject) (gen.UnsubscribePushResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("UnsubscribePush")
	}
	if _, err := d.Q.DeletePushSubscriptionForUser(ctx, dbgen.DeletePushSubscriptionForUserParams{
		Endpoint: req.Body.Endpoint,
		UserID:   fam.UserID,
	}); err != nil {
		return nil, err
	}
	return gen.UnsubscribePush200JSONResponse{Ok: gen.OkOkTrue}, nil
}

// TestPush implements POST /api/push/test. REF: "{sent: n} via
// Deps.Push.ToUser(currentUser)". The payload matches
// apps/api/src/routes/push.ts's byte-for-byte (title, body, and the /home
// deep link the frontend's service worker reads on notification click).
func (d Deps) TestPush(ctx context.Context, _ gen.TestPushRequestObject) (gen.TestPushResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	sent, err := d.Push.ToUser(ctx, fam.UserID, push.PushPayload{
		Title: "Pjokk",
		Body:  "Push works on this device ✅",
		URL:   "/home",
	})
	if err != nil {
		return nil, err
	}
	return gen.TestPush200JSONResponse{Sent: sent}, nil
}
