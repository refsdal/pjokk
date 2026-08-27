import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  fromAcceptLanguage,
  hasSessionCookie,
} from "../src/worker/landing/index";

// The landing page is the one non-/api path the Worker owns. Everything it
// decides — language, call to action, indexability — is decided server-side
// from the request, so it is all testable here.

const get = (path = "/", headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost${path}`, { headers, redirect: "manual" });

// `wrangler types` narrows each var to the literal it holds in config, so
// flipping one for a test needs a widened view of the same bindings object.
const vars = env as unknown as { OPEN_SIGNUP: string; INDEXABLE: string };

describe("landing page", () => {
  const originalIndexable = vars.INDEXABLE;
  const originalOpenSignup = vars.OPEN_SIGNUP;

  afterEach(() => {
    vars.INDEXABLE = originalIndexable;
    vars.OPEN_SIGNUP = originalOpenSignup;
  });

  it("serves an HTML document at /", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("When did the baby last eat?");
  });

  it("never lets a shared cache hold the page", async () => {
    const res = await get();
    expect(res.headers.get("cache-control")).toContain("private");
    const vary = res.headers.get("vary") ?? "";
    expect(vary).toContain("Cookie");
    expect(vary).toContain("Accept-Language");
  });

  it("ships a script-free content security policy", async () => {
    const res = await get();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).not.toContain("<script");
  });

  describe("language", () => {
    it("follows the device language", async () => {
      const res = await get("/", { "accept-language": "nb-NO,nb;q=0.9" });
      const html = await res.text();
      expect(html).toContain('<html lang="nb">');
      expect(html).toContain("Når spiste babyen sist?");
    });

    it("carries the founder story in both languages", async () => {
      const en = await (await get()).text();
      expect(en).toContain("Built by parents, for parents");
      expect(en).toContain("Was she eating enough?");

      const nb = await (await get("/", { "accept-language": "nb-NO" })).text();
      expect(nb).toContain("Laget av foreldre, for foreldre");
      expect(nb).toContain("Spiste hun nok?");
      // Both paragraphs plus the signature, not just the first.
      expect(nb).toContain("Vi bruker Pjokk hver dag");
      expect(nb).toContain("Oslo");
    });

    it("treats no and nn as Norwegian", () => {
      expect(fromAcceptLanguage("no")).toBe("nb");
      expect(fromAcceptLanguage("nn-NO")).toBe("nb");
    });

    it("prefers the highest-quality tag it recognises", () => {
      expect(fromAcceptLanguage("de;q=1.0,en;q=0.8,nb;q=0.9")).toBe("nb");
      expect(fromAcceptLanguage("de,fr")).toBe("en");
      expect(fromAcceptLanguage(null)).toBe("en");
      // q=0 means "not acceptable" and must not be selected.
      expect(fromAcceptLanguage("nb;q=0,en;q=0.5")).toBe("en");
    });

    it("lets ?lang= override the device, and remembers the choice", async () => {
      const res = await get("/?lang=en", { "accept-language": "nb-NO,nb" });
      const html = await res.text();
      expect(html).toContain('<html lang="en">');
      expect(res.headers.get("set-cookie")).toContain("pjokk_lang=en");
    });

    it("prefers a remembered choice over the device language", async () => {
      const res = await get("/", {
        "accept-language": "en-GB,en",
        cookie: "pjokk_lang=nb",
      });
      expect(await res.text()).toContain('<html lang="nb">');
    });

    it("ignores a junk lang value rather than reflecting it", async () => {
      const res = await get("/?lang=%3Cscript%3E", {
        "accept-language": "en-GB",
      });
      const html = await res.text();
      expect(html).toContain('<html lang="en">');
      expect(html).not.toContain("<script");
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("points link previews at an absolute image URL", async () => {
      const html = await (await get()).text();
      // Scrapers do not resolve relative paths — this must be absolute.
      expect(html).toContain(
        `<meta property="og:image" content="${env.APP_URL}/og.png">`,
      );
      expect(html).toContain('content="summary_large_image"');
    });

    it("offers the other language to crawlers and readers alike", async () => {
      const html = await (await get()).text();
      expect(html).toContain('hreflang="nb"');
      expect(html).toContain("/?lang=nb");
    });
  });

  describe("call to action", () => {
    it("sends a stranger to sign in", async () => {
      vars.OPEN_SIGNUP = "0";
      const html = await (await get()).text();
      expect(html).toContain('href="/login"');
      expect(html).toContain("Sign in");
      expect(html).not.toContain("Open app");
    });

    it("invites a stranger to start when signup is open", async () => {
      vars.OPEN_SIGNUP = "1";
      const html = await (await get()).text();
      expect(html).toContain("Get started");
      expect(html).toContain('href="/login"');
    });

    it("sends a signed-in visitor into the app", async () => {
      const html = await (
        await get("/", {
          cookie: "better-auth.session_token=abc123.signature",
        })
      ).text();
      expect(html).toContain("Open app");
      expect(html).toContain('href="/home"');
    });

    it("recognises the __Secure- cookie production actually sets", () => {
      expect(
        hasSessionCookie("__Secure-better-auth.session_token=abc.def"),
      ).toBe(true);
      expect(hasSessionCookie("better-auth.session_token=abc.def")).toBe(true);
      // An empty value is a cleared cookie, not a session.
      expect(hasSessionCookie("better-auth.session_token=")).toBe(false);
      expect(hasSessionCookie("pjokk_lang=nb")).toBe(false);
      expect(hasSessionCookie(null)).toBe(false);
    });
  });

  describe("indexability", () => {
    it("keeps non-production hosts out of search results", async () => {
      vars.INDEXABLE = "0";
      const res = await get();
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(await res.text()).toContain('name="robots"');
    });

    it("lets production be indexed", async () => {
      vars.INDEXABLE = "1";
      const res = await get();
      expect(res.headers.get("x-robots-tag")).toBeNull();
      const html = await res.text();
      expect(html).not.toContain('name="robots"');
      // Canonical comes from APP_URL, so an alias host cannot fork the page.
      expect(html).toContain(`<link rel="canonical" href="${env.APP_URL}/">`);
    });
  });
});
