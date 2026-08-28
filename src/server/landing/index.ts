import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { isLandingLang, LANDING_COPY, type LandingLang } from "./copy";
import { renderLandingPage } from "./page";

// GET / — the public landing page.
//
// Reaching this handler at all requires "/" in the assets `run_worker_first`
// list in wrangler.jsonc: without it, non-API requests are served straight
// from the asset store and the Worker never sees them.

export const LANG_COOKIE = "pjokk_lang";

/** Explicit click (?lang=) wins, then a remembered choice, then the device. */
export function resolveLang(
  query: string | undefined,
  cookie: string | undefined,
  acceptLanguage: string | null,
): LandingLang {
  if (isLandingLang(query)) return query;
  if (isLandingLang(cookie)) return cookie;
  return fromAcceptLanguage(acceptLanguage);
}

/** Highest-q tag we recognise wins; Norwegian is nb, no and nn alike. */
export function fromAcceptLanguage(header: string | null): LandingLang {
  if (!header) return "en";
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number.parseFloat(q);
      return {
        base: (tag ?? "").trim().toLowerCase().split("-")[0] ?? "",
        q: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((t) => t.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { base } of tags) {
    if (base === "nb" || base === "no" || base === "nn") return "nb";
    if (base === "en") return "en";
  }
  return "en";
}

/** Presence only — never validated. A stale cookie costs the visitor one
 *  redirect through /login and saves a D1 read on every page view. */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  // Over https better-auth prefixes the cookie __Secure-, so match both. The
  // trailing `.` requires a value: a cleared cookie is not a session.
  return cookieHeader
    .split(";")
    .some((c) =>
      /^(?:__Secure-|__Host-)?better-auth\.session_token=./.test(c.trim()),
    );
}

export function landing(c: Context<{ Bindings: Env }>): Response {
  const requested = c.req.query("lang");
  const lang = resolveLang(
    requested,
    getCookie(c, LANG_COOKIE),
    c.req.header("accept-language") ?? null,
  );
  const copy = LANDING_COPY[lang];

  const signedIn = hasSessionCookie(c.req.header("cookie") ?? null);
  const openSignup = String(c.env.OPEN_SIGNUP) === "1";
  const cta = signedIn
    ? { label: copy.ctaOpenApp, href: "/home" }
    : {
        label: openSignup ? copy.ctaGetStarted : copy.ctaSignIn,
        href: "/login",
      };

  const origin = new URL(c.env.APP_URL).origin;
  // Anything that is not production must stay out of search results even if
  // robots.txt is ignored.
  const noindex = String(c.env.INDEXABLE) !== "1";

  const html = renderLandingPage({ lang, cta, origin, noindex });

  if (isLandingLang(requested)) {
    setCookie(c, LANG_COOKIE, requested, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "Lax",
      httpOnly: false,
      secure: origin.startsWith("https:"),
    });
  }

  c.header("Content-Type", "text/html; charset=utf-8");
  // Varies on the visitor's cookies and device language, so it must not be
  // held in a shared cache.
  c.header("Cache-Control", "private, no-cache");
  c.header("Vary", "Cookie, Accept-Language");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Tighter than the SPA's policy in public/_headers: this document has no
  // scripts at all, and its only styles are the inline block it ships with.
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  if (noindex) c.header("X-Robots-Tag", "noindex, nofollow");

  return c.body(html);
}
