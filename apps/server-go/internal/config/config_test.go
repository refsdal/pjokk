package config

import (
	"os"
	"strings"
	"testing"
)

// minimal returns the smallest env map that Load accepts — the S3 driver
// with all four S3 vars present, mirroring apps/server/test/config.test.ts's
// MINIMAL fixture (extended with STORAGE_DRIVER, which the TS predecessor
// never had: it always assumed S3).
func minimal() map[string]string {
	return map[string]string{
		"DATABASE_URL":         "postgres://pjokk:pw@localhost:5432/pjokk",
		"APP_URL":              "https://pjokk.no",
		"AUTH_SECRET":          strings.Repeat("a", 32),
		"STORAGE_DRIVER":       "s3",
		"S3_BUCKET":            "pjokk-files",
		"S3_ENDPOINT":          "http://minio:9000",
		"S3_ACCESS_KEY_ID":     "key",
		"S3_SECRET_ACCESS_KEY": "secret",
	}
}

// clone copies base and applies overrides; a "" value deletes the key so
// tests can simulate an unset variable.
func clone(base map[string]string, overrides map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(overrides))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overrides {
		if v == "" {
			delete(out, k)
			continue
		}
		out[k] = v
	}
	return out
}

func TestLoad_AcceptsMinimalConfiguration(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.DatabaseURL != "postgres://pjokk:pw@localhost:5432/pjokk" {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.StorageDriver != "s3" {
		t.Errorf("StorageDriver = %q", cfg.StorageDriver)
	}
}

func TestLoad_MissingDatabaseURL(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"DATABASE_URL": ""}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("error %q does not mention DATABASE_URL", err.Error())
	}
}

func TestLoad_MissingAppURL(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"APP_URL": ""}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "APP_URL") {
		t.Errorf("error %q does not mention APP_URL", err.Error())
	}
}

func TestLoad_MissingAuthSecret(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"AUTH_SECRET": ""}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "AUTH_SECRET") {
		t.Errorf("error %q does not mention AUTH_SECRET", err.Error())
	}
}

func TestLoad_ReportsAllProblemsAtOnce(t *testing.T) {
	// One restart per mistake makes first-run setup miserable, so a bad
	// config must name every fault in a single error.
	_, err := Load(clone(minimal(), map[string]string{
		"DATABASE_URL": "",
		"APP_URL":      "not-a-url",
		"AUTH_SECRET":  "short",
	}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	msg := err.Error()
	for _, want := range []string{"DATABASE_URL", "APP_URL", "AUTH_SECRET"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention %s", msg, want)
		}
	}
}

func TestLoad_SiteURLDefaultsToApex(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.SiteURL != "https://pjokk.no" {
		t.Errorf("SiteURL = %q, want https://pjokk.no", cfg.SiteURL)
	}
}

func TestLoad_SiteURLOverride(t *testing.T) {
	cfg, err := Load(clone(minimal(), map[string]string{"SITE_URL": "https://example.com"}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.SiteURL != "https://example.com" {
		t.Errorf("SiteURL = %q", cfg.SiteURL)
	}
}

func TestLoad_PortCoercesFromString(t *testing.T) {
	cfg, err := Load(clone(minimal(), map[string]string{"PORT": "8080"}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.Port != 8080 {
		t.Errorf("Port = %d, want 8080", cfg.Port)
	}
}

func TestLoad_PortDefaultsTo3000(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.Port != 3000 {
		t.Errorf("Port = %d, want 3000", cfg.Port)
	}
}

func TestLoad_RejectsNonNumericPort(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"PORT": "abc"}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "PORT") {
		t.Errorf("error %q does not mention PORT", err.Error())
	}
}

func TestLoad_RejectsZeroPort(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"PORT": "0"}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "PORT") {
		t.Errorf("error %q does not mention PORT", err.Error())
	}
}

func TestLoad_TrustedProxyHopsDefaultsToZero(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.TrustedProxyHops != 0 {
		t.Errorf("TrustedProxyHops = %d, want 0", cfg.TrustedProxyHops)
	}
}

func TestLoad_TrustedProxyHopsCoercesFromString(t *testing.T) {
	cfg, err := Load(clone(minimal(), map[string]string{"TRUSTED_PROXY_HOPS": "2"}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.TrustedProxyHops != 2 {
		t.Errorf("TrustedProxyHops = %d, want 2", cfg.TrustedProxyHops)
	}
}

func TestLoad_RejectsNegativeProxyHops(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"TRUSTED_PROXY_HOPS": "-1"}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "TRUSTED_PROXY_HOPS") {
		t.Errorf("error %q does not mention TRUSTED_PROXY_HOPS", err.Error())
	}
}

func TestLoad_RejectsShortAuthSecret(t *testing.T) {
	// Limen wants 32 bytes, not the 16 the better-auth predecessor accepted.
	_, err := Load(clone(minimal(), map[string]string{"AUTH_SECRET": strings.Repeat("a", 31)}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "AUTH_SECRET") {
		t.Errorf("error %q does not mention AUTH_SECRET", err.Error())
	}
}

func TestLoad_AcceptsExactly32ByteAuthSecret(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"AUTH_SECRET": strings.Repeat("a", 32)}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

func TestLoad_FSDriverRequiresFSPath(t *testing.T) {
	env := map[string]string{
		"DATABASE_URL":   "postgres://pjokk:pw@localhost:5432/pjokk",
		"APP_URL":        "https://pjokk.no",
		"AUTH_SECRET":    strings.Repeat("a", 32),
		"STORAGE_DRIVER": "fs",
	}
	_, err := Load(env)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "STORAGE_FS_PATH") {
		t.Errorf("error %q does not mention STORAGE_FS_PATH", err.Error())
	}
}

func TestLoad_FSDriverAcceptedWithFSPath(t *testing.T) {
	env := map[string]string{
		"DATABASE_URL":    "postgres://pjokk:pw@localhost:5432/pjokk",
		"APP_URL":         "https://pjokk.no",
		"AUTH_SECRET":     strings.Repeat("a", 32),
		"STORAGE_DRIVER":  "fs",
		"STORAGE_FS_PATH": "/data/files",
	}
	cfg, err := Load(env)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.StorageFSPath != "/data/files" {
		t.Errorf("StorageFSPath = %q", cfg.StorageFSPath)
	}
}

func TestLoad_S3DriverRequiresAllFourVars(t *testing.T) {
	for _, missing := range []string{"S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"} {
		t.Run(missing, func(t *testing.T) {
			_, err := Load(clone(minimal(), map[string]string{missing: ""}))
			if err == nil {
				t.Fatalf("expected error for missing %s, got nil", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Errorf("error %q does not mention %s", err.Error(), missing)
			}
		})
	}
}

func TestLoad_S3RegionDefaultsToAuto(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.S3Region != "auto" {
		t.Errorf("S3Region = %q, want auto", cfg.S3Region)
	}
}

func TestLoad_RejectsInvalidStorageDriver(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"STORAGE_DRIVER": "azure"}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "STORAGE_DRIVER") {
		t.Errorf("error %q does not mention STORAGE_DRIVER", err.Error())
	}
}

func TestLoad_RequiresStorageDriver(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"STORAGE_DRIVER": ""}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "STORAGE_DRIVER") {
		t.Errorf("error %q does not mention STORAGE_DRIVER", err.Error())
	}
}

func TestLoad_OptionalSubsystemsDefaultEmpty(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.GoogleClientID != "" || cfg.GoogleClientSecret != "" {
		t.Errorf("expected empty Google credentials, got %q / %q", cfg.GoogleClientID, cfg.GoogleClientSecret)
	}
	if cfg.VAPIDPublicKey != "" || cfg.VAPIDPrivateKey != "" {
		t.Errorf("expected empty VAPID keys, got %q / %q", cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey)
	}
}

func TestLoad_OpenSignupFlag(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.OpenSignup != false {
		t.Errorf("OpenSignup default = %v, want false", cfg.OpenSignup)
	}

	cfg, err = Load(clone(minimal(), map[string]string{"OPEN_SIGNUP": "1"}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.OpenSignup != true {
		t.Errorf("OpenSignup = %v, want true", cfg.OpenSignup)
	}
}

func TestLoad_RejectsInvalidOpenSignupValue(t *testing.T) {
	_, err := Load(clone(minimal(), map[string]string{"OPEN_SIGNUP": "yes"}))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "OPEN_SIGNUP") {
		t.Errorf("error %q does not mention OPEN_SIGNUP", err.Error())
	}
}

func TestDisabledSubsystems_NamesUnconfiguredSubsystems(t *testing.T) {
	cfg, err := Load(minimal())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	got := cfg.DisabledSubsystems()
	want := []string{"Google sign-in", "web push"}
	if len(got) != len(want) {
		t.Fatalf("DisabledSubsystems() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("DisabledSubsystems()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestDisabledSubsystems_EmptyWhenFullyConfigured(t *testing.T) {
	cfg, err := Load(clone(minimal(), map[string]string{
		"GOOGLE_CLIENT_ID":     "gid",
		"GOOGLE_CLIENT_SECRET": "gsecret",
		"VAPID_PUBLIC_KEY":     "vpub",
		"VAPID_PRIVATE_KEY":    "vpriv",
	}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	got := cfg.DisabledSubsystems()
	if len(got) != 0 {
		t.Errorf("DisabledSubsystems() = %v, want empty", got)
	}
}

func TestDisabledSubsystems_HalfConfiguredGoogleCountsAsDisabled(t *testing.T) {
	// A client ID with no secret cannot authenticate anything; reporting it
	// as enabled would be a lie.
	cfg, err := Load(clone(minimal(), map[string]string{"GOOGLE_CLIENT_ID": "gid"}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	got := cfg.DisabledSubsystems()
	found := false
	for _, name := range got {
		if name == "Google sign-in" {
			found = true
		}
	}
	if !found {
		t.Errorf("DisabledSubsystems() = %v, want it to contain Google sign-in", got)
	}
}

func TestDisabledSubsystems_HalfConfiguredVAPIDCountsAsDisabled(t *testing.T) {
	// A public key with no private key cannot sign anything; reporting web
	// push as enabled would be a lie, same reasoning as the Google case
	// above.
	cfg, err := Load(clone(minimal(), map[string]string{"VAPID_PUBLIC_KEY": "vpub"}))
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	got := cfg.DisabledSubsystems()
	found := false
	for _, name := range got {
		if name == "web push" {
			found = true
		}
	}
	if !found {
		t.Errorf("DisabledSubsystems() = %v, want it to contain web push", got)
	}
}

func TestFromOS_WrapsOSEnviron(t *testing.T) {
	for k, v := range minimal() {
		t.Setenv(k, v)
	}
	// Ensure no ambient PORT/TRUSTED_PROXY_HOPS from the host leaks in.
	t.Setenv("PORT", "4242")

	cfg, err := FromOS()
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if cfg.DatabaseURL != os.Getenv("DATABASE_URL") {
		t.Errorf("DatabaseURL = %q", cfg.DatabaseURL)
	}
	if cfg.Port != 4242 {
		t.Errorf("Port = %d, want 4242", cfg.Port)
	}
}
