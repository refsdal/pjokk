import { mkdir, writeFile } from "node:fs/promises";
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

const SITE_URL = process.env.SITE_URL ?? "https://pjokk.no";
const APP_URL = process.env.APP_URL ?? "https://app.pjokk.no";
const OPEN_SIGNUP = process.env.OPEN_SIGNUP === "1";
const INDEXABLE = process.env.INDEXABLE !== "0";

const OUT = new URL("./dist/", import.meta.url);

async function write(path: string, body: string) {
  const target = new URL(path, OUT);
  await mkdir(new URL(".", target), { recursive: true });
  await writeFile(target, body);
}

for (const lang of ["en", "nb"] as LandingLang[]) {
  const copy = LANDING_COPY[lang];
  // No session to read on a static host, so the CTA is unconditional. It
  // points at the app's own origin now that the two are different hosts.
  const cta = {
    label: OPEN_SIGNUP ? copy.ctaGetStarted : copy.ctaSignIn,
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

console.log(
  "landing: wrote dist/index.html, dist/nb/index.html, dist/{privacy,terms}/index.html, dist/nb/{privacy,terms}/index.html",
);
