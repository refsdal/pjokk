// Package config loads and validates Pjokk's process configuration from
// environment variables. This replaces apps/server/src/env.ts: the same
// "parse once at startup, fail loudly with every problem at once" rule
// applies, so a malformed DATABASE_URL kills the container on boot — a
// crash-looping pod is loud and obvious — rather than surfacing as a 500 on
// the first request that happens to touch the database.
//
// See docs/superpowers/plans/2026-08-31-go-migration-reference.md §A3 for
// the exact env-var contract this file implements.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config is the process's validated configuration. Every field is
// populated by Load; there is no lazy or partial state.
type Config struct {
	DatabaseURL string
	AppURL      string
	SiteURL     string
	AuthSecret  string

	StorageDriver     string // "s3" | "fs"
	S3Bucket          string
	S3Endpoint        string
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3Region          string
	StorageFSPath     string

	GoogleClientID     string
	GoogleClientSecret string
	VAPIDPublicKey     string
	VAPIDPrivateKey    string

	OpenSignup       bool
	Port             int
	TrustedProxyHops int

	// PhotoQuotaMB caps the milestone photos a family may store (issue
	// #48); 0 disables the quota. Default 500.
	PhotoQuotaMB int
}

// problemCollector accumulates every validation failure instead of
// short-circuiting on the first one — one restart per mistake makes
// first-run setup miserable.
type problemCollector struct {
	problems []string
}

func (p *problemCollector) add(field, message string) {
	p.problems = append(p.problems, fmt.Sprintf("%s: %s", field, message))
}

// requireNonEmpty reads env[field], reporting it missing if absent/empty.
// Returns the value and whether it was present.
func (p *problemCollector) requireNonEmpty(env map[string]string, field string) (string, bool) {
	v := env[field]
	if v == "" {
		p.add(field, fmt.Sprintf("%s is required", field))
		return "", false
	}
	return v, true
}

// requireURL is requireNonEmpty plus the absolute-URL check the two
// required URL settings (APP_URL, S3_ENDPOINT) both apply. Returns "" on
// either failure, so a rejected value never reaches the Config.
func (p *problemCollector) requireURL(env map[string]string, field string) string {
	v, ok := p.requireNonEmpty(env, field)
	if !ok {
		return ""
	}
	if !isValidAbsoluteURL(v) {
		p.add(field, "must be a valid absolute URL")
		return ""
	}
	return v
}

// urlField is requireURL for an OPTIONAL setting: absent or empty leaves
// *dest at whatever default the caller seeded it with, and so does an
// invalid value — which is reported, so the process still refuses to boot.
func (p *problemCollector) urlField(env map[string]string, field string, dest *string) {
	v, present := env[field]
	if !present || v == "" {
		return
	}
	if !isValidAbsoluteURL(v) {
		p.add(field, "must be a valid absolute URL")
		return
	}
	*dest = v
}

// intField reads an optional integer setting, returning def when absent,
// empty, or invalid. belowMin is spelled out per field rather than derived
// from min: "must be positive" and "must be at least 0 (0 disables the
// quota)" each tell the operator something a generic phrasing would lose.
func (p *problemCollector) intField(env map[string]string, field string, def, min int, belowMin string) int {
	v, present := env[field]
	if !present || v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		p.add(field, "must be a valid integer")
		return def
	}
	if n < min {
		p.add(field, belowMin)
		return def
	}
	return n
}

// boolFlag reads a strict "0"/"1" flag, defaulting to false when absent or
// empty and reporting a problem for anything else.
//
// Shared by Load and LoadLanding on purpose: OPEN_SIGNUP means the same
// thing in both runtimes and they are routinely given the same .env, so a
// value one accepts and the other silently reads as false is a mismatch
// nothing would surface. LoadLanding used to do `== "1"`, which meant
// OPEN_SIGNUP=true crash-looped the app (loudly, fine) while the landing
// page quietly advertised the wrong call to action.
//
// Deliberately strict rather than permissive: the fail-safe default stays
// false, and the point is to REJECT an unrecognised value rather than guess
// which way the operator meant it.
func (p *problemCollector) boolFlag(env map[string]string, field string) bool {
	switch env[field] {
	case "", "0":
		return false
	case "1":
		return true
	default:
		p.add(field, `must be "0" or "1"`)
		return false
	}
}

// isValidAbsoluteURL reports whether v parses as an absolute URL with a
// scheme and host, the same shape zod's .url() accepts.
func isValidAbsoluteURL(v string) bool {
	u, err := url.Parse(v)
	if err != nil {
		return false
	}
	return u.Scheme != "" && u.Host != ""
}

// Load parses and validates configuration from a plain string map (the
// shape both a real environ and a test fixture share). It reports EVERY
// invalid or missing field in a single error, never just the first.
func Load(env map[string]string) (*Config, error) {
	p := &problemCollector{}
	cfg := &Config{}

	// --- Required: without these the process cannot serve a request ---

	if v, ok := p.requireNonEmpty(env, "DATABASE_URL"); ok {
		cfg.DatabaseURL = v
	}

	cfg.AppURL = p.requireURL(env, "APP_URL")

	cfg.SiteURL = "https://pjokk.no"
	p.urlField(env, "SITE_URL", &cfg.SiteURL)

	if v, ok := p.requireNonEmpty(env, "AUTH_SECRET"); ok {
		if len(v) < 32 {
			p.add("AUTH_SECRET", "must be at least 32 bytes")
		} else {
			cfg.AuthSecret = v
		}
	}

	// --- Object storage: driver picks which vars are required ---

	driver, driverOK := p.requireNonEmpty(env, "STORAGE_DRIVER")
	if driverOK {
		switch driver {
		case "s3":
			cfg.StorageDriver = driver
			if v, ok := p.requireNonEmpty(env, "S3_BUCKET"); ok {
				cfg.S3Bucket = v
			}
			cfg.S3Endpoint = p.requireURL(env, "S3_ENDPOINT")
			if v, ok := p.requireNonEmpty(env, "S3_ACCESS_KEY_ID"); ok {
				cfg.S3AccessKeyID = v
			}
			if v, ok := p.requireNonEmpty(env, "S3_SECRET_ACCESS_KEY"); ok {
				cfg.S3SecretAccessKey = v
			}
			cfg.S3Region = "auto"
			if v := env["S3_REGION"]; v != "" {
				cfg.S3Region = v
			}
		case "fs":
			cfg.StorageDriver = driver
			if v, ok := p.requireNonEmpty(env, "STORAGE_FS_PATH"); ok {
				cfg.StorageFSPath = v
			}
		default:
			p.add("STORAGE_DRIVER", `must be one of: "s3", "fs"`)
		}
	}

	// --- Optional subsystems: absent is legitimate, a self-hosted instance
	// may run without Google sign-in or web push and should boot and serve
	// rather than crash-loop over a feature it never uses. ---

	cfg.GoogleClientID = env["GOOGLE_CLIENT_ID"]
	cfg.GoogleClientSecret = env["GOOGLE_CLIENT_SECRET"]
	cfg.VAPIDPublicKey = env["VAPID_PUBLIC_KEY"]
	cfg.VAPIDPrivateKey = env["VAPID_PRIVATE_KEY"]

	// --- Behaviour switches ---

	cfg.OpenSignup = p.boolFlag(env, "OPEN_SIGNUP")

	cfg.Port = p.intField(env, "PORT", 3000, 1, "must be positive")
	cfg.TrustedProxyHops = p.intField(env, "TRUSTED_PROXY_HOPS", 0, 0, "must be at least 0")
	cfg.PhotoQuotaMB = p.intField(env, "PHOTO_QUOTA_MB", 500, 0, "must be at least 0 (0 disables the quota)")

	if len(p.problems) > 0 {
		return nil, fmt.Errorf("invalid configuration:\n  %s", strings.Join(p.problems, "\n  "))
	}
	return cfg, nil
}

// osEnv snapshots the process environment as the plain map Load and
// LoadLanding both take — the one place either loader touches os.
func osEnv() map[string]string {
	env := make(map[string]string, len(os.Environ()))
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	return env
}

// FromOS loads configuration from the process's real environment.
func FromOS() (*Config, error) { return Load(osEnv()) }

// DisabledSubsystems names the optional subsystems that are unconfigured
// (or only half-configured, which is the same as unconfigured — a public
// VAPID key with no private key cannot sign anything). Logged at startup
// so "push isn't working" is answered by the boot log rather than an
// afternoon of debugging.
func (c *Config) DisabledSubsystems() []string {
	var off []string
	if c.GoogleClientID == "" || c.GoogleClientSecret == "" {
		off = append(off, "Google sign-in")
	}
	if c.VAPIDPublicKey == "" || c.VAPIDPrivateKey == "" {
		off = append(off, "web push")
	}
	return off
}

// --- landing mode -----------------------------------------------------

// Landing is the configuration for `pjokk landing`, the dispatch mode that
// serves the prerendered marketing site and nothing else.
//
// It is a separate type and a separate loader because that mode shares none
// of the app's requirements — no database, no auth secret, no object storage
// — and Load would reject an otherwise perfect landing deployment for
// missing all three. Keeping it here rather than reading os.Getenv in
// cmd/pjokk preserves the rule that every setting is declared, defaulted and
// validated in this package.
type Landing struct {
	SiteURL    string
	AppURL     string
	Port       int
	OpenSignup bool
	Indexable  bool
}

// LoadLanding parses the landing site's configuration. Every field has a
// working default — the real pjokk.no deployment — so a bare
// `docker run ghcr.io/refsdal/pjokk landing` serves the right thing. Like
// Load, it reports every problem at once.
func LoadLanding(env map[string]string) (*Landing, error) {
	p := &problemCollector{}
	cfg := &Landing{
		SiteURL: "https://pjokk.no",
		AppURL:  "https://app.pjokk.no",
		Port:    3000,
	}

	p.urlField(env, "SITE_URL", &cfg.SiteURL)
	p.urlField(env, "APP_URL", &cfg.AppURL)
	cfg.Port = p.intField(env, "PORT", cfg.Port, 1, "must be positive")

	// Both fail-safe: absent or "0" means off, matching the build-time flags
	// these replaced. A deploy that forgets INDEXABLE must publish noindex,
	// not Allow: /. Parsed by the same helper the app uses, so a shared .env
	// cannot mean two different things — see boolFlag.
	cfg.OpenSignup = p.boolFlag(env, "OPEN_SIGNUP")
	cfg.Indexable = p.boolFlag(env, "INDEXABLE")

	if len(p.problems) > 0 {
		return nil, fmt.Errorf("invalid configuration:\n  %s", strings.Join(p.problems, "\n  "))
	}
	return cfg, nil
}

// LandingFromOS loads the landing site's configuration from the process's
// real environment.
func LandingFromOS() (*Landing, error) { return LoadLanding(osEnv()) }
