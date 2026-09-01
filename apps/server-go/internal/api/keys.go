package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/refsdal/pjokk/server/internal/api/gen"
	"github.com/refsdal/pjokk/server/internal/api/middleware"
	dbgen "github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file ports apps/api/src/routes/keys.ts (REF §A1's keys.ts route
// table): GET/POST /api/keys, DELETE /api/keys/{id}. Reached only via the
// tierAdmin entries api.go's operationAuthTiers gives ListApiKeys/
// CreateApiKey/RevokeApiKey — middleware.RequireAdmin already answers both
// "not available to API keys" (a key can never mint or manage keys) and
// "family admin only", so this file, like sleep_locations.go, only has the
// domain logic RequireAdmin can't provide.
//
// # Key format: a deliberate divergence from the TypeScript predecessor
//
// apps/api/src/db/scoped.ts's generateApiKey base64url-encodes 24 random
// bytes (`pjk_` + 32 base64url chars). This port instead hex-encodes 20
// random bytes (`pjk_` + 40 hex chars, per this task's brief) — a different
// alphabet, not a smaller keyspace (20 random bytes is MORE entropy than
// TS's 24-byte input has after the 4:3 stretch of base64: both encode
// exactly 20-24 bytes of crypto/rand output, hex just spends 2 characters
// per byte instead of ~1.33). Nothing depends on the two ports producing
// bit-identical tokens — every key is minted and verified within whichever
// binary issued it (APIKeyAuth in this same Go binary only ever compares
// against SHA-256 digests THIS generator produced) — so the alphabet is
// free to differ. What must match, and does: the `pjk_` prefix
// APIKeyAuth's apiKeyPrefix constant checks for, the SHA-256-hex digest
// GetAPIKeyByHash looks up, and the "prefix = first 12 characters of the
// full key" convention (progress.md's T6→T19 cross-check) — 12 chars is
// "pjk_" plus 8 hex characters, a displayable head a user can recognise
// their key by without the rest ever touching the database.
const apiKeyRandomBytes = 20 // 40 hex chars

// generateAPIKey returns a fresh `pjk_`-prefixed bearer token: 20
// crypto/rand bytes, hex-encoded (40 characters). See this file's package
// doc comment for why this differs from apps/api's base64url encoding.
func generateAPIKey() (string, error) {
	buf := make([]byte, apiKeyRandomBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("api: generate API key: %w", err)
	}
	return apiKeyTokenPrefix + hex.EncodeToString(buf), nil
}

// apiKeyTokenPrefix mirrors middleware.apiKeyPrefix (an unexported constant
// of a different package, so it can't be referenced directly) — both MUST
// stay "pjk_", since APIKeyAuth only recognises a bearer with this prefix
// as one of ours.
const apiKeyTokenPrefix = "pjk_"

// apiKeyPrefixLen is how many leading characters of the full key are stored
// as the displayable "prefix" column (see this file's doc comment).
const apiKeyPrefixLen = 12

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// serAPIKey converts one api_key row to its wire shape. Never includes the
// key itself — see CreateApiKey for the one response that does.
func serAPIKey(row dbgen.ApiKey) gen.ApiKey {
	return gen.ApiKey{
		Id:         row.ID,
		Name:       row.Name,
		Prefix:     row.Prefix,
		CreatedAt:  row.CreatedAt.Time,
		LastUsedAt: tsPtr(row.LastUsedAt),
		RevokedAt:  tsPtr(row.RevokedAt),
		ExpiresAt:  tsPtr(row.ExpiresAt),
		ReadOnly:   row.ReadOnly,
	}
}

// ListApiKeys implements GET /api/keys. REF: "ApiKey[] for the family,
// newest first, key material never included". Every key ever issued is
// listed, revoked or not — see queries/api_keys.sql's ListAPIKeys.
func (d Deps) ListApiKeys(ctx context.Context, _ gen.ListApiKeysRequestObject) (gen.ListApiKeysResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	rows, err := d.Q.ListAPIKeys(ctx, fam.FamilyID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.ApiKey, len(rows))
	for i, row := range rows {
		out[i] = serAPIKey(row)
	}
	return gen.ListApiKeys200JSONResponse(out), nil
}

// CreateApiKey implements POST /api/keys. REF: "{name(1..60),
// expiresInDays?(1..3650), readOnly?} → 201 with the full key, shown
// exactly once". Free — no plan gate (see this file's package doc comment
// and api.go's operationAuthTiers entry: the TypeScript predecessor's
// canUse(family, "apiKeys") 402 is removed).
func (d Deps) CreateApiKey(ctx context.Context, req gen.CreateApiKeyRequestObject) (gen.CreateApiKeyResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	if req.Body == nil {
		return nil, errNoRequestBody("CreateApiKey")
	}
	body := req.Body

	raw, err := generateAPIKey()
	if err != nil {
		return nil, err
	}

	readOnly := false
	if body.ReadOnly != nil {
		readOnly = *body.ReadOnly
	}

	var expiresAt pgtype.Timestamptz
	if body.ExpiresInDays != nil {
		expiresAt = pgtype.Timestamptz{
			Time:  d.Now().Add(time.Duration(*body.ExpiresInDays) * 24 * time.Hour),
			Valid: true,
		}
	}

	row, err := d.Q.CreateAPIKey(ctx, dbgen.CreateAPIKeyParams{
		FamilyID:  fam.FamilyID,
		Name:      body.Name,
		KeyHash:   sha256Hex(raw),
		Prefix:    raw[:apiKeyPrefixLen],
		CreatedBy: fam.UserID,
		ExpiresAt: expiresAt,
		ReadOnly:  readOnly,
	})
	if err != nil {
		return nil, err
	}

	created := serAPIKey(row)
	return gen.CreateApiKey201JSONResponse{
		Id:         created.Id,
		Name:       created.Name,
		Prefix:     created.Prefix,
		CreatedAt:  created.CreatedAt,
		LastUsedAt: created.LastUsedAt,
		RevokedAt:  created.RevokedAt,
		ExpiresAt:  created.ExpiresAt,
		ReadOnly:   created.ReadOnly,
		Key:        raw,
	}, nil
}

// RevokeApiKey implements DELETE /api/keys/{id}. REF: "{ok:true} / 404".
// Soft-delete (sets revoked_at) rather than a real DELETE — see
// queries/api_keys.sql's RevokeAPIKey doc comment for why: a revoked key
// must become indistinguishable from one that never existed to
// middleware.APIKeyAuth, without losing the row's audit trail. Revoking an
// already-revoked key, or an unknown/cross-family id, both affect zero rows
// and both answer 404 — the caller cannot tell the two apart, matching
// apps/api/src/db/scoped.ts's revokeApiKey.
func (d Deps) RevokeApiKey(ctx context.Context, req gen.RevokeApiKeyRequestObject) (gen.RevokeApiKeyResponseObject, error) {
	fam := middleware.FamilyFromContext(ctx)
	n, err := d.Q.RevokeAPIKey(ctx, dbgen.RevokeAPIKeyParams{
		ID:        req.Id,
		FamilyID:  fam.FamilyID,
		RevokedAt: pgtype.Timestamptz{Time: d.Now(), Valid: true},
	})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return gen.RevokeApiKey404JSONResponse(notFound()), nil
	}
	return gen.RevokeApiKey200JSONResponse{Ok: gen.OkOkTrue}, nil
}
