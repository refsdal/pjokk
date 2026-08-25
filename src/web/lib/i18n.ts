// Runtime i18n. Every user-facing string is written in English in the code
// and passes through t(); the active dictionary maps it. "auto" follows the
// device language (Norwegian devices get bokmål), with a manual override in
// Settings. Stored per device.

export type LanguageMode = "auto" | "en" | "nb";

const LANG_KEY = "pjokk.lang";

const nb: Record<string, string> = {
  // Tabs & shell
  Home: "Hjem",
  Timeline: "Tidslinje",
  Stats: "Statistikk",
  Settings: "Innstillinger",
  "A new version is ready": "En ny versjon er klar",
  Update: "Oppdater",

  // Home
  "Last feed": "Siste måltid",
  "Last diaper": "Siste bleie",
  "Last sleep": "Siste søvn",
  Feed: "Måltid",
  Diaper: "Bleie",
  Sleep: "Søvn",
  Sleeping: "Sover",
  "Sleeping…": "Sover…",
  More: "Mer",
  Wake: "Våknet",
  since: "siden",
  "No baby yet": "Ingen baby ennå",
  "Add your baby to start tracking.": "Legg til babyen din for å komme i gang.",
  "Add baby": "Legg til baby",
  solids: "fast føde",

  // Sheets: shared
  Save: "Lagre",
  Delete: "Slett",
  "Tap again to delete": "Trykk igjen for å slette",
  "Note (optional)": "Notat (valgfritt)",
  Now: "Nå",
  "15 m ago": "15 min siden",
  "Pick time": "Velg tid",
  "Saved offline — will sync": "Lagret uten nett — synkroniseres",
  "Could not save": "Kunne ikke lagre",
  "Couldn't load": "Kunne ikke laste inn",
  "Try again": "Prøv igjen",

  // Feed sheet
  Bottle: "Flaske",
  Breast: "Bryst",
  Solids: "Fast føde",
  Left: "Venstre",
  Right: "Høyre",
  Both: "Begge",
  "Edit feed": "Rediger måltid",
  "Could not save feed: ": "Kunne ikke lagre måltid: ",
  "Could not update feed: ": "Kunne ikke oppdatere måltid: ",

  // Diaper sheet
  Wet: "Tiss",
  Dirty: "Bæsj",
  wet: "tiss",
  dirty: "bæsj",
  both: "begge",
  "Edit diaper": "Rediger bleie",
  "Wet diaper": "Tissebleie",
  "Dirty diaper": "Bæsjebleie",
  "Wet + dirty diaper": "Tiss + bæsj",
  "Could not save diaper: ": "Kunne ikke lagre bleie: ",
  "Could not update diaper: ": "Kunne ikke oppdatere bleie: ",

  // Sleep sheet
  Crib: "Seng",
  Stroller: "Vogn",
  Arms: "Armkroken",
  "Start sleep": "Start søvn",
  "Edit sleep": "Rediger søvn",
  "Fell asleep": "Sovnet",
  "Woke up": "Våknet",
  "Still sleeping — end the session with Wake on Home.":
    "Sover fortsatt — avslutt økten med Våknet på Hjem.",
  "Could not start sleep: ": "Kunne ikke starte søvn: ",
  "Could not update sleep: ": "Kunne ikke oppdatere søvn: ",
  "Could not wake: ": "Kunne ikke avslutte søvn: ",
  "Could not delete: ": "Kunne ikke slette: ",

  // More / other activity types
  "Log something": "Logg noe",
  Medicine: "Medisin",
  Bath: "Bad",
  Note: "Notat",
  Milestone: "Milepæl",
  Measurement: "Måling",
  Pump: "Pumping",
  "Edit medicine": "Rediger medisin",
  "Edit bath": "Rediger bad",
  "Edit note": "Rediger notat",
  "Edit milestone": "Rediger milepæl",
  "Edit measurement": "Rediger måling",
  "Edit pump": "Rediger pumping",
  "Medicine name": "Navn på medisin",
  drops: "dråper",
  dose: "dose",
  "What happened?": "Hva skjedde?",
  "Milestone (e.g. “First steps”)": "Milepæl (f.eks. «Første skritt»)",
  Weight: "Vekt",
  Length: "Lengde",
  Head: "Hodeomkrets",
  "Could not save: ": "Kunne ikke lagre: ",
  "Could not update: ": "Kunne ikke oppdatere: ",

  // Timeline
  All: "Alle",
  Feeds: "Måltider",
  Diapers: "Bleier",
  Other: "Annet",
  Today: "I dag",
  Yesterday: "I går",
  feed: "måltid",
  feeds: "måltider",
  nap: "lur",
  naps: "lurer",
  diaper: "bleie",
  diapers: "bleier",
  other: "annet",
  by: "av",
  active: "aktiv",
  "Load more": "Last inn mer",
  "Loading…": "Laster…",
  "Nothing here yet — log something from Home.":
    "Ingenting her ennå — logg noe fra Hjem.",

  // Stats
  Week: "Uke",
  Month: "Måned",
  "Sleep / day": "Søvn / dag",
  "Intake / day": "Inntak / dag",
  "Sleep per day": "Søvn per dag",
  h: "t",
  m: "m",
  "Growth (WHO weight-for-age)": "Vekst (WHO vekt-for-alder)",
  "Reference lines: WHO P3 / P50 / P97 · months on the x-axis":
    "Referanselinjer: WHO P3 / P50 / P97 · måneder på x-aksen",
  ". percentile (WHO)": ". persentil (WHO)",
  "~": "ca. ",
  "set sex in Settings for percentiles":
    "angi kjønn i Innstillinger for persentiler",
  "Log a weight under More → Measurement": "Logg en vekt under Mer → Måling",

  // Settings
  Family: "Familie",
  admin: "admin",
  member: "medlem",
  "Invite a caretaker": "Inviter en omsorgsperson",
  "New invite link": "Ny invitasjonslenke",
  "Copy link": "Kopier lenke",
  Revoke: "Trekk tilbake",
  "Expires ": "Utløper ",
  used: "brukt",
  "Invite link copied": "Invitasjonslenke kopiert",
  "Invite QR code": "QR-kode for invitasjon",
  "Create a link and show the QR to whoever is joining — it expires after 72 hours.":
    "Lag en lenke og vis QR-koden til den som skal bli med — den utløper etter 72 timer.",
  Babies: "Babyer",
  "Edit baby": "Rediger baby",
  Girl: "Jente",
  Boy: "Gutt",
  "Birth date": "Fødselsdato",
  "sex not set": "kjønn ikke angitt",
  "Sex is only used for WHO growth percentiles.":
    "Kjønn brukes kun til WHO-vekstpersentiler.",
  Notifications: "Varsler",
  "Enable notifications": "Slå på varsler",
  "Disable on this device": "Slå av på denne enheten",
  "Remind me when no feed for": "Minn meg på når det ikke er logget måltid på",
  Off: "Av",
  "Send test notification": "Send testvarsel",
  "Test sent — check your notifications": "Test sendt — sjekk varslene dine",
  "No delivery — try re-enabling push":
    "Ingen levering — prøv å slå på push på nytt",
  "Notifications enabled on this device":
    "Varsler er slått på på denne enheten",
  "Push failed": "Push feilet",
  "Push is not available in this browser. On iPhone, add Pjokk to the Home Screen first.":
    "Push er ikke tilgjengelig i denne nettleseren. På iPhone: legg Pjokk til på Hjem-skjermen først.",
  Appearance: "Utseende",
  System: "System",
  Light: "Lys",
  Dark: "Mørk",
  Language: "Språk",
  Auto: "Auto",
  English: "English",
  Norwegian: "Norsk",
  "Night mode": "Nattmodus",
  On: "På",
  From: "Fra",
  Until: "Til",
  "API keys": "API-nøkler",
  "Bearer keys for Home Assistant, Grafana & friends. Keys can read and log, but never manage the family.":
    "Bearer-nøkler for Home Assistant, Grafana og venner. Nøkler kan lese og logge, men aldri administrere familien.",
  "Copy this key now — it will never be shown again":
    "Kopier nøkkelen nå — den vises aldri igjen",
  "Copy key": "Kopier nøkkel",
  "Key copied": "Nøkkel kopiert",
  "Key name (e.g. “Home Assistant”)": "Navn (f.eks. «Home Assistant»)",
  Create: "Opprett",
  "never used": "aldri brukt",
  "read-only": "kun lesing",
  expires: "utløper",
  "Read + write": "Lese + skrive",
  "Read-only": "Kun lesing",
  "90 days": "90 dager",
  "1 year": "1 år",
  "Never expires": "Utløper aldri",
  Data: "Data",
  "Everything ever logged, one row per entry — plain CSV.":
    "Alt som noen gang er logget, én rad per oppføring — ren CSV.",
  "Export CSV": "Eksporter CSV",
  Account: "Konto",
  "Sign out": "Logg ut",
  "API docs": "API-dokumentasjon",

  // Login / join / welcome
  "Family baby tracker": "Babylogg for familien",
  "Continue with Google": "Fortsett med Google",
  or: "eller",
  Email: "E-post",
  Password: "Passord",
  "Sign in with email": "Logg inn med e-post",
  "Sign-in failed": "Innlogging feilet",
  "Pjokk is invite-only. Ask a family admin for an invite link.":
    "Pjokk er kun på invitasjon. Be en familieadmin om en invitasjonslenke.",
  "Checking invite…": "Sjekker invitasjon…",
  "Invite not valid": "Invitasjonen er ikke gyldig",
  "This invite link is ": "Denne invitasjonslenken er ",
  invalid: "ugyldig",
  ". Ask for a fresh one.": ". Be om en ny.",
  "Join ": "Bli med i ",
  "You are invited as ": "Du er invitert som ",
  "Join family": "Bli med i familien",
  "Joining…": "Blir med…",
  "Already have an account?": "Har du allerede en konto?",
  "Sign in": "Logg inn",
  "Welcome to ": "Velkommen til ",
  "Join failed": "Kunne ikke bli med",
  "Set up your family": "Sett opp familien din",
  "Almost there": "Nesten fremme",
  "Pjokk is invite-only. Open the invite link (or scan the QR) from your family's admin to join.":
    "Pjokk er kun på invitasjon. Åpne invitasjonslenken (eller skann QR-koden) fra familiens admin for å bli med.",
  "Who are we tracking?": "Hvem skal vi følge med på?",
  "Create family": "Opprett familie",
  "Family name (e.g. “The Olsens”)": "Familienavn (f.eks. «Olsen»)",
  "Baby's name": "Babyens navn",
  Failed: "Feilet",
};

function readMode(): LanguageMode {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "en" || v === "nb" || v === "auto") return v;
  } catch {
    // storage unavailable
  }
  return "auto";
}

function resolve(mode: LanguageMode): "en" | "nb" {
  if (mode !== "auto") return mode;
  const langs =
    typeof navigator !== "undefined"
      ? [navigator.language, ...(navigator.languages ?? [])]
      : [];
  return langs.some((l) => /^(nb|nn|no)/i.test(l ?? "")) ? "nb" : "en";
}

let active: Record<string, string> | null =
  resolve(readMode()) === "nb" ? nb : null;

export function getLanguageMode(): LanguageMode {
  return readMode();
}

export function setLanguageMode(mode: LanguageMode): void {
  try {
    localStorage.setItem(LANG_KEY, mode);
  } catch {
    // storage unavailable
  }
  active = resolve(mode) === "nb" ? nb : null;
}

export function t(s: string): string {
  return active?.[s] ?? s;
}
