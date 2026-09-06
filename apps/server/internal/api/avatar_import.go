package api

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// Google picture import (spec §3). Limen's OAuth profile mapping
// (internal/auth's googlePlugin) stores Google's picture URL in users.image
// at sign-in. Nothing serves that URL — the CSP forbids third-party images
// and hot-linking would ping Google on every page load — so the first
// GET /api/me after sign-in copies it, once, into our own object store.
//
// The URL is data from a third party: the host allowlist is what stops
// this becoming a server-side request forgery primitive.

const (
	avatarImportTimeout  = 3 * time.Second
	avatarImportMaxBytes = 1 << 20 // 1 MiB
)

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

	// Mark FIRST: whatever happens below happens once.
	if err := d.Q.MarkAvatarImportAttempted(ctx, dbgen.MarkAvatarImportAttemptedParams{
		ID:               userID,
		AvatarImportedAt: pgtype.Timestamptz{Time: d.Now(), Valid: true},
	}); err != nil {
		log.Printf("api: mark avatar import for %s: %v", userID, err)
		return
	}

	fetchCtx, cancel := context.WithTimeout(ctx, avatarImportTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, upsizeGoogleAvatar(u.String()), nil)
	if err != nil {
		return
	}
	res, err := d.AvatarImport.Client.Do(req)
	if err != nil {
		log.Printf("api: avatar import for %s: %v", userID, err)
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
