package api

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Google picture import (spec §3). Limen's OAuth profile mapping
// (internal/auth's googlePlugin) stores Google's picture URL in users.image
// at sign-in. Nothing serves that URL — the CSP forbids third-party images
// and hot-linking would ping Google on every page load — so the first
// GET /api/me after sign-in copies it, once, into our own object store.
//
// The URL is data from a third party: the host allowlist is what stops
// this becoming a server-side request forgery primitive — and that
// allowlist is checked against the initial URL AND every redirect hop
// (CheckRedirect below), since the default net/http client would otherwise
// follow a redirect straight off the allowlist.

const (
	avatarImportTimeout  = 3 * time.Second
	avatarImportMaxBytes = 1 << 20 // 1 MiB
)

// errRedirectOffAllowlist aborts a redirect chain that would leave the
// allowlisted host set — see importGoogleAvatar's CheckRedirect.
var errRedirectOffAllowlist = errors.New("avatar import: redirect left the allowlist")

// AvatarImporter is the outbound half of the import, handed in through Deps
// so tests point it at an httptest server (with the allowlist widened) and
// production wires the default client + GoogleAvatarHost. nil disables the
// import entirely.
type AvatarImporter struct {
	Client      *http.Client
	AllowedHost func(host string) bool
}

// GoogleAvatarHost is the production allowlist: googleusercontent.com and
// its subdomains, nothing else.
func GoogleAvatarHost(host string) bool {
	host = strings.ToLower(host)
	return host == "googleusercontent.com" || strings.HasSuffix(host, ".googleusercontent.com")
}

// upsizeGoogleAvatar asks for a 512 px rendition instead of Google's default
// 96 px thumbnail — the suffix is Google's documented size hint, and an
// unknown shape is left alone.
func upsizeGoogleAvatar(raw string) string {
	return strings.Replace(raw, "=s96-c", "=s512-c", 1)
}

// importGoogleAvatar runs the import for userID if it has never been
// attempted. Best-effort by design: every failure is logged and swallowed,
// because a Google outage must cost the user their picture, never their
// sign-in. Runs synchronously — worst case one avatarImportTimeout delay,
// once per account lifetime.
func (d Deps) importGoogleAvatar(ctx context.Context, userID string) {
	if d.AvatarImport == nil || d.AvatarImport.Client == nil {
		return
	}
	p, err := d.Q.GetUserProfile(ctx, userID)
	if err != nil || p.AvatarKey != nil || p.AvatarImportedAt.Valid || p.Image == nil {
		return
	}
	u, err := url.Parse(*p.Image)
	if err != nil || u.Scheme != "https" || d.AvatarImport.AllowedHost == nil || !d.AvatarImport.AllowedHost(u.Hostname()) {
		return
	}

	// Mark FIRST: the atomic claim (profile.sql's WHERE guard). rows == 0
	// means another concurrent request already claimed the import (or a
	// photo now exists some other way) — treat that as "someone else has
	// it" and do nothing further, rather than fetch and store a duplicate.
	rows, err := d.Q.MarkAvatarImportAttempted(ctx, dbgen.MarkAvatarImportAttemptedParams{
		ID:               userID,
		AvatarImportedAt: ts(d.Now()),
	})
	if err != nil {
		log.Printf("api: mark avatar import for %s: %v", userID, err)
		return
	}
	if rows == 0 {
		return
	}

	fetchCtx, cancel := context.WithTimeout(ctx, avatarImportTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, upsizeGoogleAvatar(u.String()), nil)
	if err != nil {
		return
	}
	// A shallow copy so CheckRedirect is scoped to this one request rather
	// than mutating the shared *http.Client every caller of Deps uses.
	c := *d.AvatarImport.Client
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" || !d.AvatarImport.AllowedHost(req.URL.Hostname()) {
			return errRedirectOffAllowlist
		}
		return nil
	}
	res, err := c.Do(req)
	if err != nil {
		// http.Client.Do wraps every transport failure — and CheckRedirect's
		// own errRedirectOffAllowlist above — in a *url.Error whose Error()
		// embeds the full request URL, so logging err directly would print a
		// stable pseudonymous Google identifier into logs this project
		// cannot later erase (see purge.go's comment on logging personal
		// data). Unwrap to the underlying error and log the host instead.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		log.Printf("api: avatar import for %s from %s: %v", userID, u.Hostname(), err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		log.Printf("api: avatar import for %s: status %d", userID, res.StatusCode)
		return
	}
	src, err := io.ReadAll(io.LimitReader(res.Body, avatarImportMaxBytes+1))
	if err != nil || len(src) > avatarImportMaxBytes {
		log.Printf("api: avatar import for %s: body unreadable or over %d bytes", userID, avatarImportMaxBytes)
		return
	}
	jpg, err := normalizeAvatar(src)
	if err != nil {
		log.Printf("api: avatar import for %s: %v", userID, err)
		return
	}
	if _, err := d.storeAvatar(ctx, userID, jpg); err != nil {
		log.Printf("api: avatar import for %s: store: %v", userID, err)
	}
}
