import { describe, expect, it } from "bun:test";
import { LANDING_COPY } from "../src/copy";
import { renderLandingPage, renderLegalPage } from "../src/page";

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

  // Regression coverage for a coordinator-caught bug (task-4 fix round 1):
  // the nb landing page's canonical, og:url and header logo link all pointed
  // at the English document because they were hardcoded to "/" regardless of
  // `lang`. Every self-referencing URL on a page must resolve to that same
  // page, in that page's own language.
  it("keeps canonical, og:url and the home link inside the page's own language", () => {
    const en = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(en).toContain(`<link rel="canonical" href="${SITE_URL}/">`);
    expect(en).toContain(`<meta property="og:url" content="${SITE_URL}/">`);
    expect(en).toContain('class="brand" href="/"');

    const nb = renderLandingPage({
      lang: "nb",
      cta: { label: "Logg inn", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(nb).toContain(`<link rel="canonical" href="${SITE_URL}/nb/">`);
    expect(nb).toContain(`<meta property="og:url" content="${SITE_URL}/nb/">`);
    expect(nb).toContain('class="brand" href="/nb/"');
    // The old bug's exact symptom: the English canonical/og:url must not
    // also appear on the Norwegian page.
    expect(nb).not.toContain(`<link rel="canonical" href="${SITE_URL}/">`);
    expect(nb).not.toContain(`<meta property="og:url" content="${SITE_URL}/">`);
  });

  // Regression coverage for the sibling bug: the footer's privacy/terms
  // links were hardcoded to the English document on every page, so a
  // Norwegian visitor's "Personvern" link served the English privacy policy.
  it("scopes the footer's legal links to the page's own language", () => {
    const en = renderLandingPage({
      lang: "en",
      cta: { label: "Sign in", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(en).toContain('href="/privacy"');
    expect(en).toContain('href="/terms"');

    const nb = renderLandingPage({
      lang: "nb",
      cta: { label: "Logg inn", href: `${APP_URL}/login` },
      origin: SITE_URL,
      noindex: false,
    });
    expect(nb).toContain('href="/nb/privacy"');
    expect(nb).toContain('href="/nb/terms"');
    expect(nb).not.toContain('href="/privacy"');
    expect(nb).not.toContain('href="/terms"');
  });
});

describe("renderLegalPage", () => {
  it("scopes the footer's legal links and the home link to the page's own language", () => {
    const en = renderLegalPage({
      lang: "en",
      title: "Privacy",
      body: "<p>body</p>",
      path: "/privacy",
      origin: SITE_URL,
      noindex: false,
    });
    expect(en).toContain('class="brand" href="/"');
    // Full anchor tags, not bare hrefs: path is "/privacy" here, so the nb
    // page's *language switcher* legitimately targets "/privacy" too (that
    // is the English document it switches to) — asserting on the whole
    // footer anchor, label included, is what actually pins down the footer
    // link rather than colliding with that unrelated, correct link.
    expect(en).toContain('<a href="/privacy">Privacy</a>');
    expect(en).toContain('<a href="/terms">Terms</a>');

    const nb = renderLegalPage({
      lang: "nb",
      title: "Personvern",
      body: "<p>innhold</p>",
      path: "/privacy",
      origin: SITE_URL,
      noindex: false,
    });
    expect(nb).toContain('class="brand" href="/nb/"');
    expect(nb).toContain('<a href="/nb/privacy">Personvern</a>');
    expect(nb).toContain('<a href="/nb/terms">Vilkår</a>');
    // The nb document's footer must not link back to the English documents
    // (its language switcher legitimately does — see comment above).
    expect(nb).not.toContain('<a href="/privacy">Personvern</a>');
    expect(nb).not.toContain('<a href="/terms">Vilkår</a>');
  });

  // Regression coverage: the SPA shell this replaced rendered a "Last
  // updated" / "Sist oppdatert" date under the title, but the constants
  // (UPDATED_EN / UPDATED_NB) went unreferenced when renderLegalPage was
  // written, so a GDPR Article 9 privacy policy silently lost its version
  // date. See legal/layout.tsx for the constants themselves.
  it("renders the last-updated date under the title, in the page's own language", () => {
    const en = renderLegalPage({
      lang: "en",
      title: "Privacy",
      body: "<p>body</p>",
      path: "/privacy",
      origin: SITE_URL,
      noindex: false,
    });
    expect(en).toContain("Last updated 27 August 2026");

    const nb = renderLegalPage({
      lang: "nb",
      title: "Personvern",
      body: "<p>innhold</p>",
      path: "/privacy",
      origin: SITE_URL,
      noindex: false,
    });
    expect(nb).toContain("Sist oppdatert 27. august 2026");
  });

  it("gives each language its own canonical URL", () => {
    const en = renderLegalPage({
      lang: "en",
      title: "Privacy",
      body: "<p>body</p>",
      path: "/privacy",
      origin: SITE_URL,
      noindex: false,
    });
    expect(en).toContain(`<link rel="canonical" href="${SITE_URL}/privacy">`);

    const nb = renderLegalPage({
      lang: "nb",
      title: "Personvern",
      body: "<p>innhold</p>",
      path: "/privacy",
      origin: SITE_URL,
      noindex: false,
    });
    expect(nb).toContain(
      `<link rel="canonical" href="${SITE_URL}/nb/privacy">`,
    );
  });
});
