import { describe, expect, it } from "bun:test";
import { disabledSubsystems, type Env, loadEnv } from "../src/env";

// The minimum that must be present for the process to serve anything.
const MINIMAL = {
  DATABASE_URL: "postgres://pjokk:pw@localhost:5432/pjokk",
  APP_URL: "https://pjokk.no",
  BETTER_AUTH_SECRET: "0123456789abcdef0123",
  S3_BUCKET: "pjokk-files",
  S3_ENDPOINT: "http://minio:9000",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

describe("loadEnv", () => {
  it("accepts a minimal configuration", () => {
    expect(() => loadEnv(MINIMAL)).not.toThrow();
  });

  it("reports every problem at once, not just the first", () => {
    // One restart per mistake makes first-run setup miserable, so a bad
    // config must name all of its faults in a single message.
    let message = "";
    try {
      loadEnv({ ...MINIMAL, APP_URL: "nonsense", BETTER_AUTH_SECRET: "short" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("APP_URL");
    expect(message).toContain("BETTER_AUTH_SECRET");
  });

  it("refuses to start without a database", () => {
    const { DATABASE_URL: _, ...withoutDb } = MINIMAL;
    expect(() => loadEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it("refuses to start without object storage", () => {
    const { S3_BUCKET: _, ...withoutBucket } = MINIMAL;
    expect(() => loadEnv(withoutBucket)).toThrow(/S3_BUCKET/);
  });

  it("defaults SITE_URL to the public apex", () => {
    // The app links out to its legal pages, which live on the apex now
    // rather than behind auth (PR #17) — a self-hoster who never sets this
    // still gets a working link, not an empty href.
    expect(loadEnv(MINIMAL).SITE_URL).toBe("https://pjokk.no");
  });

  it("defaults to trusting no proxies", () => {
    // Trusting X-Forwarded-For by default would let any caller forge a fresh
    // rate-limit bucket per request.
    expect(loadEnv(MINIMAL).TRUSTED_PROXY_HOPS).toBe(0);
  });

  it("coerces numeric settings from strings", () => {
    const env = loadEnv({ ...MINIMAL, PORT: "8080", TRUSTED_PROXY_HOPS: "2" });
    expect(env.PORT).toBe(8080);
    expect(env.TRUSTED_PROXY_HOPS).toBe(2);
  });

  it("rejects a negative proxy hop count", () => {
    expect(() => loadEnv({ ...MINIMAL, TRUSTED_PROXY_HOPS: "-1" })).toThrow();
  });

  it("boots with optional subsystems unconfigured", () => {
    // A self-hoster running neither Google sign-in, push nor billing should
    // get a working app, not a crash loop.
    const env = loadEnv(MINIMAL);
    expect(env.STRIPE_SECRET_KEY).toBe("");
    expect(env.GOOGLE_CLIENT_ID).toBe("");
  });
});

describe("disabledSubsystems", () => {
  it("names each unconfigured subsystem", () => {
    expect(disabledSubsystems(loadEnv(MINIMAL))).toEqual([
      "Google sign-in",
      "web push",
      "billing",
    ]);
  });

  it("is empty once everything is configured", () => {
    const full: Env = loadEnv({
      ...MINIMAL,
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gsecret",
      VAPID_PUBLIC_KEY: "vpub",
      VAPID_PRIVATE_KEY: "vpriv",
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec",
    });
    expect(disabledSubsystems(full)).toEqual([]);
  });

  it("treats a half-configured subsystem as disabled", () => {
    // A public VAPID key with no private key cannot sign anything; reporting
    // it as enabled would be a lie.
    const half = loadEnv({ ...MINIMAL, VAPID_PUBLIC_KEY: "vpub" });
    expect(disabledSubsystems(half)).toContain("web push");
  });
});
