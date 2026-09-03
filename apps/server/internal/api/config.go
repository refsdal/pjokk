package api

import (
	"context"

	gen "github.com/refsdal/pjokk/server/internal/api/gen"
)

// GetConfig implements GET /api/config. Unauthenticated (tierPublic): the
// /login and /join screens read it to decide which account-creation paths
// to offer — the credential signup form (only under OPEN_SIGNUP) and one
// button per configured OAuth provider (never a dead button). No secrets;
// just two booleans-worth of config the client already infers indirectly.
func (d Deps) GetConfig(_ context.Context, _ gen.GetConfigRequestObject) (gen.GetConfigResponseObject, error) {
	providers := d.OAuthProviders
	if providers == nil {
		providers = []string{}
	}
	return gen.GetConfig200JSONResponse{
		OpenSignup:     d.OpenSignup,
		OauthProviders: providers,
	}, nil
}
