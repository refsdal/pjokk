// Marketing copy for the public landing page, in whole per-language blocks.
//
// Deliberately NOT routed through the app's t() dictionary: that maps short UI
// strings keyed by their English text, and scripts/check-i18n.mjs diffs it.
// Marketing prose is long, it churns, and a headline split across a dozen
// dictionary keys rots. The legal pages made the same call.

export type LandingLang = "en" | "nb";

export const LANDING_LANGS: readonly LandingLang[] = ["en", "nb"];

export function isLandingLang(value: unknown): value is LandingLang {
  return value === "en" || value === "nb";
}

interface Point {
  title: string;
  body: string;
}

export interface LandingCopy {
  /** <html lang> */
  htmlLang: string;
  title: string;
  description: string;
  skipToContent: string;
  tagline: string;
  /** Header/hero CTA, by what the visitor can actually do right now. */
  ctaOpenApp: string;
  ctaSignIn: string;
  ctaGetStarted: string;
  heroTitle: string;
  heroBody: string;
  freeLine: string;
  inviteLine: string;
  otherLang: string;
  demoCaption: string;
  pointsTitle: string;
  points: [Point, Point, Point];
  privacyTitle: string;
  privacyBody: string;
  storyTitle: string;
  /** Two paragraphs; kept apart so they can be edited without touching HTML. */
  storyBody: [string, string];
  storySignature: string;
  footerPrivacy: string;
  footerTerms: string;
  /** Alt/aria text for the animated mock-up. */
  demoAlt: string;
  /** Alt text for the link-preview card (public/og.png). */
  ogImageAlt: string;
  /** Strings baked into the mock-up itself. */
  demo: {
    baby: string;
    age: string;
    lastFeed: string;
    lastFeedAgo: string;
    lastFeedJustNow: string;
    lastDiaper: string;
    lastDiaperAgo: string;
    feed: string;
    diaper: string;
    sleep: string;
    more: string;
    sheetTitle: string;
    sheetAmount: string;
    sheetWhen: string;
    sheetSave: string;
    sleeping: string;
    sleepingFor: string;
  };
}

const en: LandingCopy = {
  htmlLang: "en",
  title: "Pjokk — the baby tracker that answers before you ask",
  description:
    "Feeds, naps and nappies for the whole family, in one glance. Two taps to log, works offline, and every byte stays in the EU.",
  skipToContent: "Skip to content",
  tagline: "Family baby tracker",
  ctaOpenApp: "Open app",
  ctaSignIn: "Sign in",
  ctaGetStarted: "Get started",
  heroTitle: "When did the baby last eat?",
  heroBody:
    "Pjokk answers the moment you open it — and logs the next feed in two taps. Built for the whole family, and for the three-in-the-morning version of you.",
  freeLine: "Free and self-hosted. All features included.",
  inviteLine:
    "Invited to a family? Open the link or scan the QR code you were sent.",
  otherLang: "Norsk",
  demoCaption: "The home screen, doing the only thing it has to do.",
  demoAlt:
    "An animation of the Pjokk home screen: a feed is logged in two taps and the status card updates.",
  ogImageAlt: "The Pjokk app icon: a crescent moon and a small star.",
  pointsTitle: "What it is",
  points: [
    {
      title: "One glance, no taps",
      body: "Last feed, last nappy, and whether anyone is asleep right now — on the first screen, in plain relative time. Never a clock time you have to do arithmetic on.",
    },
    {
      title: "Logged in two taps",
      body: "Every form opens already filled in with your last entry. Steppers and chips, not a keyboard. It works one-handed, in the dark, and with no signal at all.",
    },
    {
      title: "The whole family, in sync",
      body: "Invite a partner, a grandparent or a nanny with a link or a QR code. Every entry records who logged it — which turns out to matter the morning after.",
    },
  ],
  privacyTitle: "Your child's data stays in Europe",
  privacyBody:
    "Pjokk is run from Norway by Refsdal Holding AS. Every database, file and backup lives in the EU. Nothing is sold, and this page carries no third-party trackers.",
  storyTitle: "Built by parents, for parents",
  storyBody: [
    "When our daughter arrived we were as unsure as everyone else. Was she eating enough? Was it normal to pee this much? Had she taken less today than yesterday — and would we even notice if she had?",
    "So we built what we needed ourselves: somewhere to write down what happens, that answers the moment you open the app. We use Pjokk every day with our own daughter, and now we're sharing it with other parents.",
  ],
  storySignature: "— Anders, Oslo",
  footerPrivacy: "Privacy",
  footerTerms: "Terms",
  demo: {
    baby: "Ingrid",
    age: "4 months",
    lastFeed: "Last feed",
    lastFeedAgo: "2 h ago",
    lastFeedJustNow: "just now",
    lastDiaper: "Last diaper",
    lastDiaperAgo: "40 m ago",
    feed: "Feed",
    diaper: "Diaper",
    sleep: "Sleep",
    more: "More",
    sheetTitle: "Bottle",
    sheetAmount: "120 ml",
    sheetWhen: "Now",
    sheetSave: "Save",
    sleeping: "Sleeping",
    sleepingFor: "1 h 12 m",
  },
};

const nb: LandingCopy = {
  htmlLang: "nb",
  title: "Pjokk — babyloggen som svarer før du rekker å spørre",
  description:
    "Måltider, søvn og bleier for hele familien, i ett blikk. To trykk for å logge, virker uten nett, og alt blir værende i EU.",
  skipToContent: "Hopp til innhold",
  tagline: "Babylogg for familien",
  ctaOpenApp: "Åpne appen",
  ctaSignIn: "Logg inn",
  ctaGetStarted: "Kom i gang",
  heroTitle: "Når spiste babyen sist?",
  heroBody:
    "Pjokk svarer med én gang du åpner appen — og logger neste måltid på to trykk. Laget for hele familien, og for deg klokka tre om natta.",
  freeLine: "Gratis og selvdrevet. Alle funksjoner inkludert.",
  inviteLine:
    "Invitert til en familie? Åpne lenka eller skann QR-koden du har fått.",
  otherLang: "English",
  demoCaption: "Hjemskjermen, som gjør det eneste den må gjøre.",
  demoAlt:
    "En animasjon av hjemskjermen i Pjokk: et måltid logges på to trykk, og statuskortet oppdaterer seg.",
  ogImageAlt: "Pjokk-ikonet: en månesigd og en liten stjerne.",
  pointsTitle: "Hva det er",
  points: [
    {
      title: "Ett blikk, null trykk",
      body: "Siste måltid, siste bleie, og om noen sover akkurat nå — rett på første skjerm, i klartekst. Aldri et klokkeslett du må regne på.",
    },
    {
      title: "Logget på to trykk",
      body: "Hvert skjema åpner seg ferdig utfylt med forrige registrering. Steppere og valgknapper, ikke tastatur. Det virker med én hånd, i mørket, og helt uten dekning.",
    },
    {
      title: "Hele familien, synkronisert",
      body: "Inviter partneren, besteforeldre eller dagmammaen med en lenke eller en QR-kode. Hver registrering viser hvem som logget den — noe som viser seg å bety noe morgenen etter.",
    },
  ],
  privacyTitle: "Barnets data blir værende i Europa",
  privacyBody:
    "Pjokk drives fra Norge av Refsdal Holding AS. Hver database, fil og sikkerhetskopi ligger i EU. Ingenting selges videre, og denne siden har ingen sporing fra tredjepart.",
  storyTitle: "Laget av foreldre, for foreldre",
  storyBody: [
    "Da datteren vår ble født, var vi like usikre som alle andre. Spiste hun nok? Var det normalt at hun tisset så mye? Hadde hun fått i seg mindre i dag enn i går — og ville vi i det hele tatt merket det?",
    "Så vi bygde det vi selv manglet: et sted å notere det som skjer, som svarer med én gang du åpner appen. Vi bruker Pjokk hver dag med vår egen datter, og nå deler vi det med andre foreldre.",
  ],
  storySignature: "— Anders, Oslo",
  footerPrivacy: "Personvern",
  footerTerms: "Vilkår",
  demo: {
    baby: "Ingrid",
    age: "4 måneder",
    lastFeed: "Siste måltid",
    lastFeedAgo: "2 t siden",
    lastFeedJustNow: "akkurat nå",
    lastDiaper: "Siste bleie",
    lastDiaperAgo: "40 min siden",
    feed: "Måltid",
    diaper: "Bleie",
    sleep: "Søvn",
    more: "Mer",
    sheetTitle: "Flaske",
    sheetAmount: "120 ml",
    sheetWhen: "Nå",
    sheetSave: "Lagre",
    sleeping: "Sover",
    sleepingFor: "1 t 12 min",
  },
};

export const LANDING_COPY: Record<LandingLang, LandingCopy> = { en, nb };
