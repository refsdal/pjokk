import { describe, expect, it } from "bun:test";
import { LANDING_COPY } from "../src/copy";
import { renderLandingPage } from "../src/page";

// Render-level assertions moved here from apps/api/test/landing.test.ts. The
// HTTP-level ones (headers, cookie negotiation, the live route) stay on the
// Hono handler and are deleted with it in Task 3. renderLandingPage is a pure
// function now that the container isn't the one calling it, so this is all
// plain function calls — no app, no fetch.

const SITE_URL = "https://pjokk.no";
const APP_URL = "https://app.pjokk.no";

describe("renderLandingPage", () => {
  it("renders a complete document for both languages", () => {
    for (const lang of ["en", "nb"] as const) {
      const html = renderLandingPage({
        lang,
        cta: { label: "Sign in", href: `${APP_URL}/login` },
        origin: SITE_URL,
        noindex: false,
      });
      expect(html).toContain("<!doctype html>");
      expect(html).toContain(`<html lang="${lang}">`);
    }
    const en = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(en).toContain("Built by parents, for parents");

    const nb = renderLandingPage({
      lang: "nb",
      cta: { label: "Logg inn", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(nb).toContain("Laget av foreldre, for foreldre");
  });

  it("follows OPEN_SIGNUP for the CTA label", () => {
    const copy = LANDING_COPY.en;

    const signInOnly = renderLandingPage({
      lang: "en",
      cta: { label: copy.ctaSignIn, href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(signInOnly).toContain(copy.ctaSignIn);
    expect(signInOnly).not.toContain(copy.ctaGetStarted);

    const openSignup = renderLandingPage({
      lang: "en",
      cta: { label: copy.ctaGetStarted, href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(openSignup).toContain(copy.ctaGetStarted);
  });

  it("points the CTA at the app origin, not a bare path", () => {
    const html = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(html).toContain(`href="${APP_URL}/login"`);
    // The old same-origin relative link must not survive the split.
    expect(html).not.toContain('href="/login"');
  });

  it("emits the noindex meta tag and header-equivalent marker only when asked", () => {
    const indexed = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(indexed).not.toContain('name="robots"');

    const noindexed = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: true,
    });
    expect(noindexed).toContain(
      '<meta name="robots" content="noindex, nofollow">',
    );
  });

  it("carries hreflang alternates for both languages", () => {
    const html = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(html).toContain('hreflang="en"');
    expect(html).toContain('hreflang="nb"');
  });
});
