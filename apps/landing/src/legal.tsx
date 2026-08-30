import { renderToStaticMarkup } from "react-dom/server";
import { En as PrivacyEn, Nb as PrivacyNb } from "./legal/privacy";
import { En as TermsEn, Nb as TermsNb } from "./legal/terms";
import type { LandingLang } from "./copy";

// The legal bodies are PRERENDERED from the SPA's own components rather than
// rewritten as templates. The prose is a legal statement about Article 9
// health data; re-typing it would put a transcription error between the
// policy and what we actually do. Rendering the same source guarantees the
// text is identical, and renderToStaticMarkup emits no React runtime, so the
// output is still a zero-JavaScript document.
//
// The components themselves live under ./legal/ (moved here, not imported
// across packages) — LegalPage, which needed useState/useRouter/Link, was
// dropped in the move; only the pure-JSX bodies and the presentational
// helpers (H, List, ControllerCard) came across.

const BODIES = {
  privacy: { en: PrivacyEn, nb: PrivacyNb },
  terms: { en: TermsEn, nb: TermsNb },
} as const;

export type LegalDoc = keyof typeof BODIES;

export function renderLegalBody(doc: LegalDoc, lang: LandingLang): string {
  const Body = BODIES[doc][lang];
  return renderToStaticMarkup(<Body />);
}
