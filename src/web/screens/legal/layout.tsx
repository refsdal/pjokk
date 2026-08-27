import { IconArrowLeft } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { getLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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

export const UPDATED_EN = "27 August 2026";
export const UPDATED_NB = "27. august 2026";
export const CONTACT = "personvern@pjokk.no";
export const COMPANY = "Refsdal Holding AS";
export const ORG_NR = "932 516 470";
export const ADDRESS_EN = "Marstrandgata 13B, 0566 Oslo, Norway";
export const ADDRESS_NB = "Marstrandgata 13B, 0566 Oslo";

export type Lang = "en" | "nb";

export function LegalPage({
  titles,
  children,
}: {
  titles: Record<Lang, string>;
  /** Called with the language the reader chose, so each page supplies the
   *  matching body. */
  children: (lang: Lang) => ReactNode;
}) {
  const router = useRouter();
  // Seeded from the app's language, but switchable here: these pages are
  // public, so a reader may never have set a preference — and a Norwegian
  // reader who lands on the English text must be able to flip it.
  const [lang, setLang] = useState<Lang>(() => getLanguage());

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pt-safe pb-16">
      <div className="flex items-center gap-2 py-4">
        <button
          type="button"
          aria-label={lang === "nb" ? "Tilbake" : "Back"}
          onClick={() => router.history.back()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink active:bg-surface-2"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="flex-1 text-2xl font-extrabold text-ink">
          {titles[lang]}
        </h1>
      </div>

      <div className="flex items-center justify-between pb-6">
        <p className="text-sm text-muted">
          {lang === "nb"
            ? `Sist oppdatert ${UPDATED_NB}`
            : `Last updated ${UPDATED_EN}`}
        </p>
        <div className="flex gap-1">
          {(["nb", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              aria-pressed={lang === l}
              className={cn(
                "h-9 rounded-full px-3 text-xs font-bold",
                lang === l
                  ? "bg-accent text-on-accent"
                  : "text-muted active:bg-surface-2",
              )}
            >
              {l === "nb" ? "Norsk" : "English"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-6 text-[15px] leading-relaxed text-ink-soft">
        {children(lang)}
      </div>

      <nav className="mt-10 flex gap-4 border-t border-line pt-6 text-sm font-semibold text-accent">
        <Link to="/privacy">{lang === "nb" ? "Personvern" : "Privacy"}</Link>
        <Link to="/terms">{lang === "nb" ? "Vilkår" : "Terms"}</Link>
        <Link to="/">
          {lang === "nb" ? "Tilbake til Pjokk" : "Back to Pjokk"}
        </Link>
      </nav>
    </div>
  );
}

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
