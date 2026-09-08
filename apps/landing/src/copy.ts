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

/** Eight one-line tiles, ordered the way a baby's first year unfolds. */
type GrowTiles = [Point, Point, Point, Point, Point, Point, Point, Point];

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
  /** The second door. Signup is invite-only, so a parent without an invite
   *  is pointed at the repository rather than at a form that will refuse
   *  them. */
  ctaSelfHost: string;
  heroTitle: string;
  heroBody: string;
  freeLine: string;
  inviteLine: string;
  otherLang: string;
  demoCaption: string;
  pointsTitle: string;
  points: [Point, Point, Point];
  growTitle: string;
  grow: GrowTiles;
  stationTitle: string;
  stationBody: string;
  stationCaption: string;
  /** Alt/aria text for the static care-station mock-up. */
  stationAlt: string;
  privacyTitle: string;
  privacyBody: string;
  /** Second paragraph of the privacy band: open source, self-hosting,
   *  importers. Same band on purpose — "where your data lives" and "you can
   *  take it with you" are one promise. */
  privacyOpenSource: string;
  techTitle: string;
  /** Plain row under the band for the technical parent; deliberately
   *  low-key so it never competes with the parent-facing pitch. */
  tech: readonly string[];
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
    awake: string;
    awakeFor: string;
    /** The nap-window guide line on the Awake card. */
    napWindow: string;
  };
  /** Strings baked into the care-station mock-up. */
  station: {
    clock: string;
    feedAgo: string;
    feedDetail: string;
    feedAction: string;
    sleepDetail: string;
    sleepAction: string;
    diaperAgo: string;
    diaperDetail: string;
    diaperAction: string;
    undoLine: string;
    undo: string;
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
  ctaSelfHost: "Run it yourself",
  heroTitle: "When did the baby last eat?",
  heroBody:
    "Pjokk answers the moment you open it — and logs the next feed in two taps. Built for the whole family, and for the three-in-the-morning version of you.",
  freeLine: "Free and self-hosted. All features included.",
  inviteLine:
    "Pjokk is invite-only for now. Invited to a family? Open the link or scan the QR code you were sent. Otherwise it is open source, and runs happily on a server of your own.",
  otherLang: "Norsk",
  demoCaption: "The home screen, doing the only thing it has to do.",
  demoAlt:
    "An animation of the Pjokk home screen: a feed is logged in two taps and the status card updates. The Awake card shows today's nap window.",
  ogImageAlt: "The Pjokk app icon: a crescent moon and a small star.",
  pointsTitle: "The first week",
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
  growTitle: "Then it grows with you",
  grow: [
    {
      title: "Night mode",
      body: "Near-black and amber between 22:00 and 07:00, with three big buttons in the bottom half of the screen. No blue light, no hunting.",
    },
    {
      title: "Nap window",
      body: "A typical nap window for her age, counted from the last wake-up. A guide, never a prediction — tired signs beat any table.",
    },
    {
      title: "Reminders",
      body: "Feed, pump and medicine nudges as push notifications, with quiet hours. Log it straight from the notification.",
    },
    {
      title: "Medicine and temperature",
      body: "Your own medicines with your own interval, so the timeline says when the next dose is OK. Temperatures flag a fever.",
    },
    {
      title: "Growth",
      body: "Weight, length and head circumference against the WHO curves, with the percentile — no more squinting at the paper chart.",
    },
    {
      title: "Vaccines",
      body: "The Norwegian childhood vaccination programme as a schedule, with the documents attached to each visit.",
    },
    {
      title: "Calendar",
      body: "Family events — repeating ones too — that everyone sees. Subscribe from the calendar app already on your phone.",
    },
    {
      title: "Milestones and the report",
      body: "Milestones with up to three photos, and a PDF of the last 30 days to bring along to the health nurse.",
    },
  ],
  stationTitle: "On the nursery wall",
  stationBody:
    "Turn an old tablet into the family's care station: three cards that show how long it has been, log with one tap, and offer an Undo. A PIN keeps it there, and the screen dims by itself at night. On a normal tablet or a laptop, the same app simply gets the wider layout.",
  stationCaption: "The care station: one tap per card, nothing else on screen.",
  stationAlt:
    "A still of the care station: three cards for feed, sleep and diaper, each with the time since, a detail line and a one-tap log button.",
  privacyTitle: "Your child's data stays in Europe",
  privacyBody:
    "Pjokk is run from Norway by Refsdal Holding AS. Every database, file and backup lives in the EU. Nothing is sold, and this page carries no third-party trackers.",
  privacyOpenSource:
    "It is also open source, and yours to run: one image, two containers, on your own server — with your history imported from Baby Buddy, sprout-track or Huckleberry.",
  techTitle: "For the technical parent",
  tech: [
    "Docker, one image",
    "CSV export",
    "API keys for Home Assistant and Grafana",
    "Calendar subscription (ICS)",
  ],
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
    awake: "Awake",
    awakeFor: "1 h 40 m",
    napWindow: "Nap window 13:10–14:25",
  },
  station: {
    clock: "12:47",
    feedAgo: "2 h 05 m",
    feedDetail: "ago · bottle 120 ml",
    feedAction: "Log 120 ml",
    sleepDetail: "Nap window 13:10–14:25",
    sleepAction: "Start sleep",
    diaperAgo: "45 m",
    diaperDetail: "ago · wet",
    diaperAction: "Log wet",
    undoLine: "Bottle 120 ml logged",
    undo: "Undo",
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
  ctaSelfHost: "Kjør den selv",
  heroTitle: "Når spiste babyen sist?",
  heroBody:
    "Pjokk svarer med én gang du åpner appen — og logger neste måltid på to trykk. Laget for hele familien, og for deg klokka tre om natta.",
  freeLine: "Gratis og selvdrevet. Alle funksjoner inkludert.",
  inviteLine:
    "Pjokk er foreløpig bare for inviterte. Invitert til en familie? Åpne lenka eller skann QR-koden du har fått. Ellers er den åpen kildekode, og trives godt på en server du eier selv.",
  otherLang: "English",
  demoCaption: "Hjemskjermen, som gjør det eneste den må gjøre.",
  demoAlt:
    "En animasjon av hjemskjermen i Pjokk: et måltid logges på to trykk, og statuskortet oppdaterer seg. Våken-kortet viser dagens lurvindu.",
  ogImageAlt: "Pjokk-ikonet: en månesigd og en liten stjerne.",
  pointsTitle: "Den første uka",
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
  growTitle: "Og så vokser den med dere",
  grow: [
    {
      title: "Nattmodus",
      body: "Nesten svart og ravgult mellom 22:00 og 07:00, med tre store knapper nederst på skjermen. Ikke noe blått lys, ingen leting.",
    },
    {
      title: "Lurvindu",
      body: "Et typisk lurvindu for alderen, regnet fra siste oppvåkning. En rettesnor, aldri en spådom — trøtthetstegn slår enhver tabell.",
    },
    {
      title: "Påminnelser",
      body: "Et lite dult om måltid, pumping og medisin som pushvarsler, med stilletid. Logg rett fra varselet.",
    },
    {
      title: "Medisin og temperatur",
      body: "Familiens egne medisiner med eget intervall, så tidslinja sier når neste dose er OK. Temperaturer flagger feber.",
    },
    {
      title: "Vekst",
      body: "Vekt, lengde og hodeomkrets mot WHO-kurvene, med persentil — slutt på myse mot papirskjemaet.",
    },
    {
      title: "Vaksiner",
      body: "Barnevaksinasjonsprogrammet som en plan, med dokumentene festet til hvert besøk.",
    },
    {
      title: "Kalender",
      body: "Familiens avtaler — gjentakende også — som alle ser. Abonner fra kalenderappen du allerede har på telefonen.",
    },
    {
      title: "Milepæler og rapporten",
      body: "Milepæler med opptil tre bilder, og en PDF av de siste 30 dagene å ta med til helsestasjonen.",
    },
  ],
  stationTitle: "På veggen på barnerommet",
  stationBody:
    "Gjør et gammelt nettbrett til familiens stellestasjon: tre kort som viser hvor lenge det er siden, logger på ett trykk og har en angreknapp. En PIN holder det på plass, og skjermen dimmes av seg selv om natta. På et vanlig nettbrett eller en laptop får den samme appen rett og slett den brede visningen.",
  stationCaption:
    "Stellestasjonen: ett trykk per kort, ingenting annet på skjermen.",
  stationAlt:
    "Et stillbilde av stellestasjonen: tre kort for måltid, søvn og bleie, hvert med tiden siden sist, en detaljlinje og en loggknapp på ett trykk.",
  privacyTitle: "Barnets data blir værende i Europa",
  privacyBody:
    "Pjokk drives fra Norge av Refsdal Holding AS. Hver database, fil og sikkerhetskopi ligger i EU. Ingenting selges videre, og denne siden har ingen sporing fra tredjepart.",
  privacyOpenSource:
    "Den er dessuten åpen kildekode, og din å drive selv: ett image, to containere, på din egen server — med historikken importert fra Baby Buddy, sprout-track eller Huckleberry.",
  techTitle: "For den tekniske forelderen",
  tech: [
    "Docker, ett image",
    "CSV-eksport",
    "API-nøkler for Home Assistant og Grafana",
    "Kalenderabonnement (ICS)",
  ],
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
    awake: "Våken",
    awakeFor: "1 t 40 min",
    napWindow: "Lurvindu 13:10–14:25",
  },
  station: {
    clock: "12:47",
    feedAgo: "2 t 05 min",
    feedDetail: "siden · flaske 120 ml",
    feedAction: "Logg 120 ml",
    sleepDetail: "Lurvindu 13:10–14:25",
    sleepAction: "Start søvn",
    diaperAgo: "45 min",
    diaperDetail: "siden · tiss",
    diaperAction: "Logg tiss",
    undoLine: "Flaske 120 ml logget",
    undo: "Angre",
  },
};

export const LANDING_COPY: Record<LandingLang, LandingCopy> = { en, nb };
