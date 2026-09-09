package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"

	"github.com/thecodearcher/limen"

	"github.com/refsdal/pjokk/server/internal/db/gen"
)

// This file is package auth's plumbing: the transaction helper, the
// client-address digest Limen is configured with, and the id generator it
// is handed. None of it is part of the package's vocabulary — see auth.go
// for that, and for why nothing outside this package may see a Limen type.

// inTx runs fn inside one transaction with a transaction-scoped querier.
// Postgres has real transactions; the D1-era pattern of a batch plus a
// separate ownership check does not need to come back (CLAUDE.md).
func (s *service) inTx(ctx context.Context, fn func(*gen.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("auth: begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(gen.New(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("auth: commit transaction: %w", err)
	}
	return nil
}

// ipDigestDomain separates the client-address key from the signing secret,
// so the two can never be the same bytes even though both derive from
// AUTH_SECRET.
const ipDigestDomain = ":client-ip"

// clientIPDigest builds the extractor both Limen's rate limiter and its
// session metadata use in place of the raw client address.
//
// HMAC rather than a bare hash: the address space is small enough to
// enumerate (a bare SHA-256 of an IPv4 address is reversible with a rainbow
// table in seconds), so the digest is only unlinkable if it is keyed. The
// key is instance-local, which is the right scope — the digest only ever
// needs to be comparable within one deployment.
//
// It reads RemoteAddr only: proxy-header handling (TRUSTED_PROXY_HOPS)
// belongs to the HTTP server that sets RemoteAddr, not here, and guessing at
// X-Forwarded-For inside the auth layer is how a limiter silently degrades
// to one shared bucket.
func clientIPDigest(key [32]byte) func(*http.Request) string {
	return func(r *http.Request) string {
		address := r.RemoteAddr
		if host, _, err := net.SplitHostPort(address); err == nil {
			address = host
		}
		mac := hmac.New(sha256.New, key[:])
		mac.Write([]byte(address))
		return hex.EncodeToString(mac.Sum(nil))
	}
}

// uuidGenerator supplies the text primary keys our schema declares. Limen
// would otherwise assume auto-increment integers and hand the database an
// int64 for a text column.
type uuidGenerator struct{}

func (uuidGenerator) Generate(context.Context) (any, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, fmt.Errorf("auth: generate id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func (uuidGenerator) GetColumnType() limen.ColumnType { return limen.ColumnTypeString }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read never returns an error on any platform this runs
		// on; treating it as fatal beats returning a predictable value.
		panic(fmt.Sprintf("auth: crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b)
}

// idString normalizes Limen's `any`-typed identifiers. With our generator
// they are always strings; the fallback keeps a surprise from becoming a
// panic.
func idString(id any) string {
	if s, ok := id.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", id)
}
