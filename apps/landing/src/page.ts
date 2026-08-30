import { LANDING_COPY, type LandingLang } from "./copy";
import { UPDATED_EN, UPDATED_NB } from "./legal/layout";
import { LANDING_CSS } from "./styles";

// The public front door. A single self-contained document: inline CSS, no
// JavaScript, no app bundle. A stranger reading marketing copy should not have
// to download a React SPA first, and the language is resolved server-side so
// nothing flashes in English before repainting in Norwegian.

export interface LandingOptions {
  lang: LandingLang;
  /** Primary call to action, decided from session cookie + OPEN_SIGNUP. */
  cta: { label: string; href: string };
  /** Absolute origin, for canonical + OpenGraph URLs. */
  origin: string;
  /** True on anything that is not the production host. */
  noindex: boolean;
}

const icons = {
  bottle: `<path d="M9.5 3h5v2.6l1.4 2.1a2 2 0 0 1 .35 1.13V19a2 2 0 0 1-2 2h-4.5a2 2 0 0 1-2-2V8.83a2 2 0 0 1 .35-1.13L9.5 5.6z"/><path d="M9.1 11.5h5.8"/>`,
  diaper: `<path d="M3.5 5.5h17v4.2a8.5 8.5 0 0 1-8.5 8.8 8.5 8.5 0 0 1-8.5-8.8z"/><path d="M8.5 12.5h7"/>`,
  moon: `<path d="M18 13.5A7.5 7.5 0 0 1 10.5 6a6.5 6.5 0 1 0 7.5 7.5z"/>`,
  plus: `<path d="M12 6v12"/><path d="M6 12h12"/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>`,
  bolt: `<path d="M13.5 3 5 13.5h6l-.5 7.5L19 10.5h-6z"/>`,
  users: `<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16.5 5.4a3.2 3.2 0 0 1 0 5.2"/><path d="M17.5 14.4A6 6 0 0 1 21 20"/>`,
};

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Copy is ours and static, but the template is HTML — escape anyway so a
 *  future edit cannot turn a stray `<` in a headline into markup. */
function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface LegalPageOptions {
  lang: LandingLang;
  /** "Privacy" / "Personvern", "Terms" / "Vilkår" — supplied by the caller
   *  rather than hardcoded here, since page.ts has no notion of "documents". */
  title: string;
  /** Prerendered body markup — see legal.tsx's renderLegalBody. */
  body: string;
  /** Path without a language prefix, e.g. "/privacy". Used for canonical +
   *  hreflang; the Norwegian document lives at "/nb" + path. */
  path: string;
  /** Absolute origin, for canonical + hreflang URLs. */
  origin: string;
  /** True on anything that is not the production host. */
  noindex: boolean;
}

/** Shell for the legal documents: same head/header/footer as the landing
 *  page, a plain title + prerendered body in between. No hero, no demo, no
 *  CTA beyond the shared header/footer links. */
export function renderLegalPage({
  lang,
  title,
  body,
  path,
  origin,
  noindex,
}: LegalPageOptions): string {
  const c = LANDING_COPY[lang];
  const other: LandingLang = lang === "en" ? "nb" : "en";
  const canonicalPath = lang === "nb" ? `/nb${path}` : path;
  // Document paths, not ?lang= query strings: on a static host the language
  // is which file you fetch, not a param the (nonexistent) server reads.
  const otherPath = other === "nb" ? `/nb${path}` : path;
  // Every link on the page must stay inside the current language's document
  // tree — a Norwegian page linking to an English document is the same
  // wrong-content bug as a dead ?lang= link, just without the query string.
  const homeHref = lang === "nb" ? "/nb/" : "/";
  const legalPrefix = lang === "nb" ? "/nb" : "";
  const updated =
    lang === "nb"
      ? `Sist oppdatert ${UPDATED_NB}`
      : `Last updated ${UPDATED_EN}`;

  return `<!doctype html>
<html lang="${c.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} — Pjokk</title>
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ""}
<link rel="canonical" href="${origin}${canonicalPath}">
<link rel="alternate" hreflang="en" href="${origin}${path}">
<link rel="alternate" hreflang="nb" href="${origin}/nb${path}">
<meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171512" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<style>${LANDING_CSS}</style>
</head>
<body>
<a class="skip" href="#main">${esc(c.skipToContent)}</a>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${homeHref}">
      <img src="/icon.svg" alt="" width="34" height="34">
      Pjokk
    </a>
    <a class="lang" href="${otherPath}" hreflang="${other}" rel="alternate">${esc(c.otherLang)}</a>
  </div>
</header>

<main id="main" class="wrap legal">
  <h1>${esc(title)}</h1>
  <p class="legal-updated">${esc(updated)}</p>
  ${body}
</main>

<footer class="site-footer">
  <div class="wrap">
    <span>&copy; 2026 Refsdal Holding AS</span>
    <a href="${legalPrefix}/privacy">${esc(c.footerPrivacy)}</a>
    <a href="${legalPrefix}/terms">${esc(c.footerTerms)}</a>
    <a class="spacer" href="mailto:personvern@pjokk.no">personvern@pjokk.no</a>
  </div>
</footer>
</body>
</html>`;
}

export function renderLandingPage({
  lang,
  cta,
  origin,
  noindex,
}: LandingOptions): string {
  const c = LANDING_COPY[lang];
  const d = c.demo;
  const other: LandingLang = lang === "en" ? "nb" : "en";
  // Document paths, not ?lang= query strings — see renderLegalPage.
  const otherPath = other === "nb" ? "/nb/" : "/";
  // Same rule as renderLegalPage: every link stays inside the current
  // language's document tree.
  const homeHref = lang === "nb" ? "/nb/" : "/";
  const legalPrefix = lang === "nb" ? "/nb" : "";

  const pointIcons = [icons.eye, icons.bolt, icons.users];

  return `<!doctype html>
<html lang="${c.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(c.title)}</title>
<meta name="description" content="${esc(c.description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ""}
<link rel="canonical" href="${origin}${homeHref}">
<link rel="alternate" hreflang="en" href="${origin}/">
<link rel="alternate" hreflang="nb" href="${origin}/nb/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pjokk">
<meta property="og:title" content="${esc(c.title)}">
<meta property="og:description" content="${esc(c.description)}">
<meta property="og:url" content="${origin}${homeHref}">
<meta property="og:locale" content="${lang === "nb" ? "nb_NO" : "en_GB"}">
<!-- Regenerate with: node apps/landing/scripts/gen-og.mjs -->
<meta property="og:image" content="${origin}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(c.ogImageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171512" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<style>${LANDING_CSS}</style>
</head>
<body>
<a class="skip" href="#main">${esc(c.skipToContent)}</a>

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${homeHref}">
      <img src="/icon.svg" alt="" width="34" height="34">
      Pjokk
    </a>
    <a class="lang" href="${otherPath}" hreflang="${other}" rel="alternate">${esc(c.otherLang)}</a>
    <a class="btn btn--sm" href="${cta.href}">${esc(cta.label)}</a>
  </div>
</header>

<main id="main">
  <div class="wrap hero">
    <div>
      <h1>${esc(c.heroTitle)}</h1>
      <p class="lead">${esc(c.heroBody)}</p>
      <div class="hero-actions">
        <a class="btn" href="${cta.href}">${esc(cta.label)}</a>
        <p class="free-line">${esc(c.freeLine)}</p>
      </div>
      <p class="invite-line">${esc(c.inviteLine)}</p>
    </div>

    <div class="demo-col">
      <div class="demo" role="img" aria-label="${esc(c.demoAlt)}">
        <div class="demo-top">
          <div class="demo-avatar">${esc(d.baby.slice(0, 1))}</div>
          <div>
            <div class="demo-name">${esc(d.baby)}</div>
            <div class="demo-age">${esc(d.age)}</div>
          </div>
        </div>

        <div class="demo-banner">
          <i class="demo-dot"></i>
          <span class="demo-banner-label">${esc(d.sleeping)}</span>
          <span class="demo-banner-time">${esc(d.sleepingFor)}</span>
        </div>

        <div class="demo-cards">
          <div class="demo-card demo-card--feed">
            <div class="demo-card-label">${esc(d.lastFeed)}</div>
            <div class="demo-card-value">
              <span class="demo-ago--old">${esc(d.lastFeedAgo)}</span>
              <span class="demo-ago--new">${esc(d.lastFeedJustNow)}</span>
            </div>
          </div>
          <div class="demo-card">
            <div class="demo-card-label">${esc(d.lastDiaper)}</div>
            <div class="demo-card-value"><span>${esc(d.lastDiaperAgo)}</span></div>
          </div>
        </div>

        <div class="demo-grid">
          <div class="demo-btn demo-btn--feed"><i class="i-feed">${svg(icons.bottle)}</i>${esc(d.feed)}</div>
          <div class="demo-btn"><i class="i-diaper">${svg(icons.diaper)}</i>${esc(d.diaper)}</div>
          <div class="demo-btn"><i class="i-sleep">${svg(icons.moon)}</i>${esc(d.sleep)}</div>
          <div class="demo-btn"><i class="i-more">${svg(icons.plus)}</i>${esc(d.more)}</div>
        </div>

        <div class="demo-tabbar"><span></span><span></span><span></span><span></span><span></span></div>

        <div class="demo-sheet">
          <div class="demo-sheet-grip"></div>
          <div class="demo-sheet-title">${esc(d.sheetTitle)}</div>
          <div class="demo-sheet-row">
            <div class="demo-pill demo-pill--on">${esc(d.sheetAmount)}</div>
            <div class="demo-pill">${esc(d.sheetWhen)}</div>
          </div>
          <div class="demo-save">${esc(d.sheetSave)}</div>
        </div>
      </div>
      <p class="demo-caption">${esc(c.demoCaption)}</p>
    </div>
  </div>

  <section class="wrap section">
    <h2>${esc(c.pointsTitle)}</h2>
    <div class="points">
      ${c.points
        .map(
          (p, i) => `<div class="point">
        <div class="point-mark">${svg(pointIcons[i] ?? icons.eye)}</div>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.body)}</p>
      </div>`,
        )
        .join("\n      ")}
    </div>
  </section>

  <div class="wrap">
    <section class="band">
      <h2>${esc(c.privacyTitle)}</h2>
      <p>${esc(c.privacyBody)}</p>
    </section>
  </div>

  <section class="wrap section story">
    <h2>${esc(c.storyTitle)}</h2>
    ${c.storyBody.map((p) => `<p>${esc(p)}</p>`).join("\n    ")}
    <p class="signature">${esc(c.storySignature)}</p>
  </section>
</main>

<footer class="site-footer">
  <div class="wrap">
    <span>&copy; 2026 Refsdal Holding AS</span>
    <a href="${legalPrefix}/privacy">${esc(c.footerPrivacy)}</a>
    <a href="${legalPrefix}/terms">${esc(c.footerTerms)}</a>
    <a class="spacer" href="mailto:personvern@pjokk.no">personvern@pjokk.no</a>
  </div>
</footer>
</body>
</html>`;
}
