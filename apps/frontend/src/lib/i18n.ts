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
  "Page not found": "Fant ikke siden",
  "Back to Pjokk": "Tilbake til Pjokk",

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
  "Other day": "Annen dag",
  "Saved offline — will sync": "Lagret uten nett — synkroniseres",
  "Could not save": "Kunne ikke lagre",
  "just now": "akkurat nå",
  "m ago": "min siden",
  "h ago": "t siden",
  yesterday: "i går",
  min: "min",
  d: "d",
  mo: "mnd",
  y: "år",
  decrease: "reduser",
  increase: "øk",
  "Couldn't load": "Kunne ikke laste inn",
  "Try again": "Prøv igjen",

  // Feed sheet
  Bottle: "Flaske",
  Breast: "Bryst",
  Solids: "Fast føde",
  Left: "Venstre",
  Right: "Høyre",
  Both: "Begge",
  "Start timer": "Start tidtaker",
  Stop: "Stopp",
  "Reset timer": "Nullstill tidtaker",
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
  "Contact nap": "Kontaktlur",
  "Start sleep": "Start søvn",
  "Edit sleep": "Rediger søvn",
  "Fell asleep": "Sovnet",
  "Woke up": "Våknet",
  "Still sleeping — end the session with Wake on Home.":
    "Sover fortsatt — avslutt økten med Våknet på Hjem.",
  "Could not start sleep: ": "Kunne ikke starte søvn: ",
  "Could not update sleep: ": "Kunne ikke oppdatere søvn: ",
  "Could not wake: ": "Kunne ikke avslutte søvn: ",

  // Play sheet
  "Tummy time": "Mageleie",
  Walk: "Tur",
  Play: "Lek",
  "Edit activity": "Rediger aktivitet",
  Started: "Startet",
  Ended: "Avsluttet",
  "Log finished activity": "Logg ferdig aktivitet",
  "Still running — finish it with Stop on Home.":
    "Pågår fortsatt — avslutt den med Stopp på Hjem.",
  "The end time is before the start time.":
    "Sluttidspunktet er før starttidspunktet.",
  "Could not stop: ": "Kunne ikke stoppe: ",
  activity: "aktivitet",

  // Vaccines
  Vaccines: "Vaksiner",
  Vaccine: "Vaksine",
  "Log vaccine": "Logg vaksine",
  "Edit vaccine": "Rediger vaksine",
  Dose: "Dose",
  due: "forfalt",
  "Other vaccines": "Andre vaksiner",
  Documents: "Dokumenter",
  "Attach document": "Legg ved dokument",
  "Uploading…": "Laster opp…",
  "Deleting a vaccine also deletes its documents.":
    "Å slette en vaksine sletter også dokumentene dens.",
  "Schedule follows": "Planen følger",
  "Check with your helsestasjon.": "Sjekk med helsestasjonen din.",
  Back: "Tilbake",

  // Legal
  About: "Om",
  Terms: "Vilkår",
  "Privacy policy": "Personvernerklæring",
  "By joining you accept our": "Ved å bli med godtar du våre",
  and: "og",
  ", including that Pjokk stores health information about your child.":
    ", inkludert at Pjokk lagrer helseopplysninger om barnet ditt.",
  Dismiss: "Skjul",
  Dismissed: "Skjulte",
  Restore: "Vis igjen",
  "About this vaccine at FHI": "Om denne vaksinen hos FHI",
  // Programme age labels (passed through t() dynamically — keep in sync with
  // data/no-vaccine-programme.json).
  "6 weeks": "6 uker",
  "3 months": "3 måneder",
  "5 months": "5 måneder",
  "12 months": "12 måneder",
  "15 months": "15 måneder",
  "2nd grade": "2. klasse",
  "6th grade": "6. klasse",
  "7th grade": "7. klasse",
  "10th grade": "10. klasse",
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
  Temperature: "Temperatur",
  "Last temperature": "Siste temperatur",
  Fever: "Feber",
  "Could not save: ": "Kunne ikke lagre: ",
  "Could not update: ": "Kunne ikke oppdatere: ",

  // Timeline
  All: "Alle",
  Feeds: "Måltider",
  Diapers: "Bleier",
  Other: "Annet",
  Today: "I dag",
  today: "i dag",
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
  Day: "Dag",
  Week: "Uke",
  Month: "Måned",
  "Sleep / day": "Søvn / dag",
  "Intake / day": "Inntak / dag",
  "Sleep today": "Søvn i dag",
  "Intake today": "Inntak i dag",
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

  // Install (PWA). The iOS step wording deliberately mirrors what Safari's
  // Norwegian share sheet actually says, so the reader can match it letter
  // for letter rather than translating back.
  Install: "Installer",
  "Install Pjokk": "Installer Pjokk",
  "Add Pjokk to your home screen": "Legg Pjokk på hjemskjermen",
  "Add to home screen": "Legg til på hjemskjermen",
  "Show me": "Vis meg",
  "It opens full screen, works offline, and gets its own icon.":
    "Den åpnes i fullskjerm, virker uten nett og får sitt eget ikon.",
  "Open Pjokk in Safari first": "Åpne Pjokk i Safari først",
  "This browser cannot add apps to the home screen. Open pjokk.no in Safari, then follow the steps below.":
    "Denne nettleseren kan ikke legge apper på hjemskjermen. Åpne pjokk.no i Safari, og følg stegene under.",
  "Tap the Share button in Safari": "Trykk på Del-knappen i Safari",
  "Scroll down and tap Add to Home Screen":
    "Bla ned og trykk «Legg til på Hjem-skjerm»",
  "Tap Add — Pjokk lands on your home screen":
    "Trykk «Legg til» — Pjokk havner på hjemskjermen",

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
  "Baby removed": "Baby fjernet",
  "Removing a baby permanently deletes every log for them.":
    "Å fjerne en baby sletter alle loggene deres for alltid.",

  // Contacts
  Contacts: "Kontakter",
  "Add contact": "Legg til kontakt",
  "Edit contact": "Rediger kontakt",
  "Contact removed": "Kontakt fjernet",
  "Doctor, helsestasjon, grandparents — the people you call.":
    "Lege, helsestasjon, besteforeldre — de du ringer.",
  Name: "Navn",
  "Type (doctor, grandma, daycare…)": "Type (lege, mormor, barnehage…)",
  Phone: "Telefon",
  Website: "Nettside",
  Notes: "Notater",
  Call: "Ring",
  "Applies to": "Gjelder for",
  "Shared by the whole family.": "Delt av hele familien.",
  "Only shown for the babies above.": "Vises bare for babyene over.",
  // Contact icon labels (passed through t() dynamically, so the i18n check
  // can't see them — keep them in sync with contactIconMeta by hand).
  // Doctor / Family / Other already live in this dictionary further down.
  Person: "Person",
  Nurse: "Helsesykepleier",
  Clinic: "Klinikk",
  Dentist: "Tannlege",
  Grandparent: "Besteforelder",
  Daycare: "Barnehage",
  Friend: "Venn",
  "Switch baby": "Bytt baby",
  "Make admin": "Gjør til admin",
  "Make member": "Gjør til medlem",
  "Role updated": "Rolle oppdatert",
  "Removed from the family": "Fjernet fra familien",
  "Remove from family": "Fjern fra familien",
  "The family needs at least one admin.": "Familien trenger minst én admin.",
  "Removing someone keeps their past entries, attributed as before.":
    "Å fjerne noen beholder tidligere oppføringer med samme navn.",
  "Tap again to confirm": "Trykk igjen for å bekrefte",
  "Sex is only used for WHO growth percentiles.":
    "Kjønn brukes kun til WHO-vekstpersentiler.",

  // Sleep locations (Settings)
  "Sleep locations": "Sovesteder",
  "Add location": "Legg til sted",
  "Extra sleep-location chips for this family, alongside Crib, Stroller & Contact nap.":
    "Ekstra valg for sovested for denne familien, i tillegg til Seng, Vogn og Kontaktlur.",
  "Location (e.g. “Hammock”)": "Sted (f.eks. «Hengekøye»)",

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
  "Always on": "Alltid på",
  "Night mode stays on until you switch it off.":
    "Nattmodus forblir på til du slår den av.",
  "Turns on at": "Slås på kl.",
  "off at": "av kl.",
  "Night mode is off.": "Nattmodus er av.",
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

  // Calendar
  Calendar: "Kalender",
  Upcoming: "Kommende",
  Tomorrow: "I morgen",
  "All day": "Hele dagen",
  "Add event": "Legg til hendelse",
  "No upcoming events": "Ingen kommende hendelser",
  Previous: "Forrige",
  Next: "Neste",
  "New event": "Ny hendelse",
  "Edit event": "Rediger hendelse",
  Title: "Tittel",
  Doctor: "Lege",
  Vaccination: "Vaksine",
  Babysitting: "Barnevakt",
  Duration: "Varighet",
  Custom: "Egendefinert",
  Responsible: "Ansvarlig",
  Reminder: "Påminnelse",
  "1 h before": "1 t før",
  "1 day before": "1 dag før",
  "Location (optional)": "Sted (valgfritt)",
  "Description (optional)": "Beskrivelse (valgfritt)",

  Data: "Data",
  "Everything ever logged, one row per entry — plain CSV.":
    "Alt som noen gang er logget, én rad per oppføring — ren CSV.",
  "Export CSV": "Eksporter CSV",
  Account: "Konto",
  "Sign out": "Logg ut",
  "API docs": "API-dokumentasjon",
  "Admin console": "Adminkonsoll",

  // Login / join / welcome
  "Family baby tracker": "Babylogg for familien",
  "Continue with Google": "Fortsett med Google",
  or: "eller",
  Email: "E-post",
  Password: "Passord",
  "Sign in with email": "Logg inn med e-post",
  "Sign-in failed": "Innlogging feilet",
  "Create account": "Opprett konto",
  "Have an account? Sign in": "Har du allerede en konto? Logg inn",
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
  "Invited to a family?": "Invitert til en familie?",
  "Open the invite link (or scan the QR) from your family's admin to join them instead.":
    "Åpne invitasjonslenken (eller skann QR-koden) fra familiens admin for å bli med hos dem i stedet.",
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

/** The language actually in effect, with "auto" already resolved against the
 *  device. Long-form pages (the legal ones) pick a whole body with this
 *  rather than going through the t() dictionary. */
export function getLanguage(): "en" | "nb" {
  return resolve(readMode());
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
