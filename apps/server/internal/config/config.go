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

	if v, ok := p.requireNonEmpty(env, "APP_URL"); ok {
		if !isValidAbsoluteURL(v) {
			p.add("APP_URL", "must be a valid absolute URL")
		} else {
			cfg.AppURL = v
		}
	}

	cfg.SiteURL = "https://pjokk.no"
	if v, present := env["SITE_URL"]; present && v != "" {
		if !isValidAbsoluteURL(v) {
			p.add("SITE_URL", "must be a valid absolute URL")
		} else {
			cfg.SiteURL = v
		}
	}

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
			if v, ok := p.requireNonEmpty(env, "S3_ENDPOINT"); ok {
				if !isValidAbsoluteURL(v) {
					p.add("S3_ENDPOINT", "must be a valid absolute URL")
				} else {
					cfg.S3Endpoint = v
				}
			}
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

	switch v := env["OPEN_SIGNUP"]; v {
	case "", "0":
		cfg.OpenSignup = false
	case "1":
		cfg.OpenSignup = true
	default:
		p.add("OPEN_SIGNUP", `must be "0" or "1"`)
	}

	cfg.Port = 3000
	if v, present := env["PORT"]; present && v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			p.add("PORT", "must be a valid integer")
		} else if n <= 0 {
			p.add("PORT", "must be positive")
		} else {
			cfg.Port = n
		}
	}

	cfg.TrustedProxyHops = 0
	if v, present := env["TRUSTED_PROXY_HOPS"]; present && v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			p.add("TRUSTED_PROXY_HOPS", "must be a valid integer")
		} else if n < 0 {
			p.add("TRUSTED_PROXY_HOPS", "must be at least 0")
		} else {
			cfg.TrustedProxyHops = n
		}
	}

	if len(p.problems) > 0 {
		return nil, fmt.Errorf("invalid configuration:\n  %s", strings.Join(p.problems, "\n  "))
	}
	return cfg, nil
}

// FromOS loads configuration from the process's real environment.
func FromOS() (*Config, error) {
	env := make(map[string]string, len(os.Environ()))
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		env[k] = v
	}
	return Load(env)
}

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

	for _, f := range []struct {
		name string
		dest *string
	}{
		{"SITE_URL", &cfg.SiteURL},
		{"APP_URL", &cfg.AppURL},
	} {
		if v, present := env[f.name]; present && v != "" {
			if !isValidAbsoluteURL(v) {
				p.add(f.name, "must be a valid absolute URL")
			} else {
				*f.dest = v
			}
		}
	}

	if v, present := env["PORT"]; present && v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			p.add("PORT", "must be a valid integer")
		} else if n <= 0 {
			p.add("PORT", "must be positive")
		} else {
			cfg.Port = n
		}
	}

	// Both fail-safe: only an explicit "1" turns them on, matching the
	// build-time flags these replaced. A deploy that forgets INDEXABLE must
	// publish noindex, not Allow: /.
	cfg.OpenSignup = env["OPEN_SIGNUP"] == "1"
	cfg.Indexable = env["INDEXABLE"] == "1"

	if len(p.problems) > 0 {
		return nil, fmt.Errorf("invalid configuration:\n  %s", strings.Join(p.problems, "\n  "))
	}
	return cfg, nil
}

// LandingFromOS loads the landing site's configuration from the process's
// real environment.
func LandingFromOS() (*Landing, error) {
	env := make(map[string]string, len(os.Environ()))
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		env[k] = v
	}
	return LoadLanding(env)
}
