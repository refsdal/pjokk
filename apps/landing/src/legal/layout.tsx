import type { ReactNode } from "react";

// Public, deliberately: someone deciding whether to accept an invite — and a
// supervisory authority — must be able to read these without an account.
//
// Long-form prose, NOT routed through t(): the dictionary is for short UI
// strings, and a policy split across hundreds of keys would rot. Each page
// therefore carries a whole English body and a whole Norwegian one, and
// picks between them.
//
// STILL OUTSTANDING before these are relied upon (see the PR checklist):
//   - review by someone qualified. Both languages were drafted by an AI; the
//     Norwegian is a translation of the English, not an independent text.
//
// LegalPage — the router-aware shell that used to wrap these bodies as an
// SPA route — needed useState/useRouter/Link, none of which survive
// renderToStaticMarkup, so it was dropped rather than moved here.
// apps/landing supplies its own shell (renderLegalPage in page.ts) around
// the bodies below.

export const UPDATED_EN = "27 August 2026";
export const UPDATED_NB = "27. august 2026";
export const CONTACT = "personvern@pjokk.no";
export const COMPANY = "Refsdal Holding AS";
export const ORG_NR = "932 516 470";
export const ADDRESS_EN = "Marstrandgata 13B, 0566 Oslo, Norway";
export const ADDRESS_NB = "Marstrandgata 13B, 0566 Oslo";

export type Lang = "en" | "nb";

export function H({ children }: { children: ReactNode }) {
  return <h2 className="pt-2 text-lg font-bold text-ink">{children}</h2>;
}

export function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

/** Controller identity block — identical in both languages apart from the
 *  country name, and the thing a regulator looks for first. */
export function ControllerCard({ lang }: { lang: Lang }) {
  return (
    <p className="text-sm text-muted">
      {COMPANY}
      <br />
      Org. nr. {ORG_NR}
      <br />
      {lang === "nb" ? ADDRESS_NB : ADDRESS_EN}
      <br />
      <a href={`mailto:${CONTACT}`} className="font-semibold text-accent">
        {CONTACT}
      </a>
    </p>
  );
}
