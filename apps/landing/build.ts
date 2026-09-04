import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { LANDING_COPY, type LandingLang } from "./src/copy";
import { type LegalDoc, renderLegalBody } from "./src/legal";
import { renderLandingPage, renderLegalPage } from "./src/page";

// Titles match what the SPA's LegalPage used to pass in before these moved
// here (Task 2/3 of the landing split).
const LEGAL_TITLES: Record<LegalDoc, Record<LandingLang, string>> = {
  privacy: { en: "Privacy", nb: "Personvern" },
  terms: { en: "Terms", nb: "Vilkår" },
};

// The landing site is BUILT, not served. Language is chosen per document at
// build time rather than negotiated per request: the old server-side
// ?lang= -> cookie -> Accept-Language chain died with the move off the
// container, and two prerendered documents with hreflang alternates are what
// a crawler wants anyway.

// TEMPLATE=1 builds the site for the container (`pjokk landing`) instead of
// for a static host: every deployment-specific value becomes an opaque token
// that apps/server/internal/landing substitutes once at startup, and the
// generated robots.txt/sitemap.xml are left to the server, which knows
// whether the host it is running on is indexable. That is what lets ONE
// image serve the apex, a test host and a self-hoster's own domain — the
// same property the app image already has. Without it, this file behaves
// exactly as before and writes a directly servable static site.
const TEMPLATE = process.env.TEMPLATE === "1";

const SITE_URL = TEMPLATE
  ? "__PJOKK_SITE_URL__"
  : (process.env.SITE_URL ?? "https://pjokk.no");
const APP_URL = TEMPLATE
  ? "__PJOKK_APP_URL__"
  : (process.env.APP_URL ?? "https://app.pjokk.no");
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === "1";
// Fail-safe default: unset means noindex, matching the container's zod
// schema default of "0" that this replaced. A deploy that forgets to set
// this variable must publish `noindex`, not `Allow: /`.
//
// Under TEMPLATE the <meta> is omitted entirely and the server sends
// X-Robots-Tag instead — a deploy-time choice rather than a build-time one.
const INDEXABLE = TEMPLATE || process.env.INDEXABLE === "1";

const OUT = new URL("./dist/", import.meta.url);
const PUBLIC = new URL("./public/", import.meta.url);

// Start clean, like vite's emptyOutDir for the SPA. Without this a file that
// one mode writes and the other does not — robots.txt and sitemap.xml, which
// the container generates at request time instead — survives from a previous
// build and gets embedded into the binary as a stale leftover.
await rm(OUT, { recursive: true, force: true });

async function write(path: string, body: string) {
  const target = new URL(path, OUT);
  await mkdir(new URL(".", target), { recursive: true });
  await writeFile(target, body);
}

// The landing site is a separate deploy from the SPA, so it carries its own
// copies of the shared assets rather than reaching into apps/frontend/public
// at build time (og.png is regenerated here by scripts/gen-og.mjs; icon.svg
// is copied from apps/frontend/public/ once, by hand, since it is hand-authored
// source with nothing to regenerate).
async function copyPublicAsset(name: string) {
  await mkdir(OUT, { recursive: true });
  await copyFile(new URL(name, PUBLIC), new URL(name, OUT));
}

await copyPublicAsset("og.png");
await copyPublicAsset("icon.svg");
// WebKit ignores an SVG apple-touch-icon, so the landing site ships the same
// PNG the SPA does (scripts/gen-icons.mjs writes both copies).
await copyPublicAsset("icon-180.png");

for (const lang of ["en", "nb"] as LandingLang[]) {
  const copy = LANDING_COPY[lang];
  // No session to read on a static host, so the CTA is unconditional. It
  // points at the app's own origin now that the two are different hosts.
  const cta = {
    // The label is a token under TEMPLATE because OPEN_SIGNUP is a runtime
    // setting there; the server picks the right string per language out of
    // cta-labels.json below, so no copy is duplicated into Go.
    label: TEMPLATE
      ? `__PJOKK_CTA_LABEL_${lang.toUpperCase()}__`
      : OPEN_SIGNUP
        ? copy.ctaGetStarted
        : copy.ctaSignIn,
    href: `${APP_URL}/login`,
  };
  const html = renderLandingPage({
    lang,
    cta,
    origin: SITE_URL,
    noindex: !INDEXABLE,
  });
  await write(lang === "en" ? "index.html" : `${lang}/index.html`, html);

  for (const doc of ["privacy", "terms"] as LegalDoc[]) {
    const body = renderLegalBody(doc, lang);
    const legalHtml = renderLegalPage({
      lang,
      title: LEGAL_TITLES[doc][lang],
      body,
      path: `/${doc}`,
      origin: SITE_URL,
      noindex: !INDEXABLE,
    });
    const path = `${doc}/index.html`;
    await write(lang === "en" ? path : `nb/${path}`, legalHtml);
  }
}

// robots.txt and sitemap.xml. These used to be served at request time by the
// container (apps/api/src/app.ts, deleted in Task 3 of the landing split);
// on a static site they are just more build output. INDEXABLE now gates a
// build-time choice rather than a runtime one, so promoting test to
// production means rebuilding, not flipping an env var on a live process.
if (!TEMPLATE) {
  await write(
    "robots.txt",
    INDEXABLE
      ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
      : "User-agent: *\nDisallow: /\n",
  );
}

// The sidecar the container reads to resolve __PJOKK_CTA_LABEL_*__.
// apps/landing/src/copy.ts stays the single source of truth for the strings.
if (TEMPLATE) {
  await write(
    "cta-labels.json",
    JSON.stringify(
      Object.fromEntries(
        (["en", "nb"] as LandingLang[]).map((l) => [
          l,
          {
            signIn: LANDING_COPY[l].ctaSignIn,
            signUp: LANDING_COPY[l].ctaGetStarted,
          },
        ]),
      ),
    ),
  );
}

if (INDEXABLE && !TEMPLATE) {
  // Recovers the format the container used to serve (last seen at
  // d7ff457d7c6f20d701bbb1e3a475a333d5ae9bec^:apps/api/src/app.ts), which
  // listed "/", "/privacy" and "/terms" with hreflang alternates on the
  // root only. The landing site prerenders both languages as real
  // documents, so all six get a <url> entry, each with the same pair of
  // alternates as the old root entry had.
  const DOC_PATHS: { en: string; nb: string }[] = [
    { en: "/", nb: "/nb/" },
    { en: "/privacy", nb: "/nb/privacy" },
    { en: "/terms", nb: "/nb/terms" },
  ];

  const urls = DOC_PATHS.flatMap(({ en, nb }) =>
    [en, nb].map(
      (loc) => `  <url>
    <loc>${SITE_URL}${loc}</loc>
    <xhtml:link rel="alternate" hreflang="en" href="${SITE_URL}${en}"/>
    <xhtml:link rel="alternate" hreflang="nb" href="${SITE_URL}${nb}"/>
  </url>`,
    ),
  ).join("\n");

  await write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`,
  );
}

console.log(
  "landing: wrote dist/index.html, dist/nb/index.html, " +
    "dist/{privacy,terms}/index.html, dist/nb/{privacy,terms}/index.html, " +
    "dist/og.png, dist/icon.svg, dist/icon-180.png" +
    (TEMPLATE
      ? ", dist/cta-labels.json (templated for the container; robots.txt " +
        "and sitemap.xml are served by `pjokk landing`)"
      : ", dist/robots.txt" +
        (INDEXABLE
          ? ", dist/sitemap.xml"
          : " (sitemap.xml skipped, not indexable)")),
);
