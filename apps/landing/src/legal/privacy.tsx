import { COMPANY, CONTACT, ControllerCard, H, List } from "./layout";

export function En() {
  return (
    <>
      <p>
        Pjokk is a baby tracker. Using it means recording information about a
        child's daily care, and some of that is health information. This page
        explains exactly what we store, why, who else can see it, and how to get
        it back or have it deleted.
      </p>

      <H>Who is responsible</H>
      <p>
        {COMPANY} is the data controller for the information you put into Pjokk
        at pjokk.no.
      </p>
      <ControllerCard lang="en" />

      <H>What we store</H>
      <List>
        <li>
          <strong>Your account:</strong> name, email address, and — if you sign
          in with Google — the fact that the account is linked to Google. We
          never receive your Google password.
        </li>
        <li>
          <strong>Your family:</strong> the family name, who its members are,
          each member's role, and invite codes you create.
        </li>
        <li>
          <strong>Each child:</strong> name, date of birth, and optionally sex
          (used only to draw growth percentiles).
        </li>
        <li>
          <strong>What you log:</strong> feeds, nappies, sleep, play, medicine,
          baths, notes, milestones, measurements, pumping, vaccines, and
          calendar events — each with a time and the caretaker who recorded it.
        </li>
        <li>
          <strong>Notification settings</strong> and, if you enable push, a
          subscription identifier for your browser or device.
        </li>
      </List>

      <H>Health information</H>
      <p>
        Some of what you log is health information about a child — vaccines,
        medicine, weight and length, and arguably the feeding and sleep record
        itself. European data protection law treats this as a special category
        requiring extra care, and we ask for your explicit consent before you
        can record it. You can withdraw that consent at any time by deleting the
        data or your family.
      </p>

      <H>Why we store it, and on what basis</H>
      <List>
        <li>
          <strong>To run the app</strong> — showing you what you logged, on
          every device your family signs in from. Basis: performance of our
          agreement with you, plus your explicit consent for health information.
        </li>
        <li>
          <strong>To send reminders you asked for</strong> — feed reminders and
          calendar reminders, only when you turn them on. Basis: your consent.
        </li>
        <li>
          <strong>To keep the service secure</strong> — rate limiting, and an
          audit trail of administrative actions. Basis: our legitimate interest
          in protecting other families' data.
        </li>
      </List>
      <p>
        We do not advertise, we do not profile you, and we do not sell or share
        your data with anyone for their own purposes.
      </p>

      <H>Who else processes it</H>
      <p>
        We use a small number of providers, each under a data processing
        agreement, and each only doing what we instruct:
      </p>
      <List>
        <li>
          <strong>Our hosting provider</strong> — servers, database and file
          storage, all within the EU. All application data lives here.
        </li>
        <li>
          <strong>Google</strong> — only if you choose to sign in with Google.
        </li>
        <li>
          <strong>Your browser's push service</strong> (Apple, Google or
          Mozilla, depending on your device) — only if you enable notifications,
          and only to deliver the notification itself.
        </li>
      </List>

      <H>Where it is stored</H>
      <p>
        Your data is stored within the European Union. Where a provider is based
        outside the EU, the transfer is covered by the European Commission's
        standard contractual clauses.
      </p>

      <H>How long we keep it</H>
      <p>
        We keep what you log for as long as your family uses Pjokk. Delete an
        entry and it is gone immediately. Delete your family and everything
        belonging to it — every log, every child, every file — is deleted
        immediately.
      </p>
      <p>
        We take an encrypted backup once a day and keep it for{" "}
        <strong>30 days</strong>. That means a deletion takes up to 30 days to
        work its way out of our backups completely. Backups are only ever used
        to restore the service after a failure.
      </p>

      <H>Your rights</H>
      <p>You can, at any time and free of charge:</p>
      <List>
        <li>
          <strong>Get a copy of everything</strong> — Settings → Data → Export
          CSV gives you every entry ever recorded, one row each.
        </li>
        <li>
          <strong>Correct anything</strong> — every entry can be edited in the
          app.
        </li>
        <li>
          <strong>Delete anything</strong>, up to and including your whole
          family.
        </li>
        <li>
          <strong>Withdraw consent</strong>, object to processing, or ask us to
          restrict it — write to {CONTACT}.
        </li>
      </List>
      <p>
        If you think we are handling your data wrongly, please tell us first,
        but you also have the right to complain to Datatilsynet, the Norwegian
        Data Protection Authority.
      </p>

      <H>Children</H>
      <p>
        Pjokk is used by adults to record information about their own children.
        The child is the subject of that information, and a parent or guardian
        exercises the child's rights on their behalf until the child is old
        enough to do so themselves.
      </p>

      <H>Security</H>
      <p>
        Every request is authenticated and scoped to a single family; there is
        no path by which one family can read another's data. Data is encrypted
        in transit and at rest. Should a breach occur that puts your rights at
        risk, we will notify the authorities within 72 hours and tell you
        directly where the law requires it.
      </p>

      <H>Changes</H>
      <p>
        If we change this page in a way that matters, we will tell you in the
        app before the change takes effect.
      </p>
    </>
  );
}

export function Nb() {
  return (
    <>
      <p>
        Pjokk er en app for å følge med på babyen. Å bruke den betyr å
        registrere opplysninger om et barns daglige omsorg, og noe av dette er
        helseopplysninger. Denne siden forklarer nøyaktig hva vi lagrer,
        hvorfor, hvem andre som ser det, og hvordan du får det ut igjen eller
        får det slettet.
      </p>

      <H>Hvem er ansvarlig</H>
      <p>
        {COMPANY} er behandlingsansvarlig for opplysningene du legger inn i
        Pjokk på pjokk.no.
      </p>
      <ControllerCard lang="nb" />

      <H>Hva vi lagrer</H>
      <List>
        <li>
          <strong>Kontoen din:</strong> navn, e-postadresse, og — hvis du logger
          inn med Google — at kontoen er koblet til Google. Vi mottar aldri
          Google-passordet ditt.
        </li>
        <li>
          <strong>Familien din:</strong> familienavnet, hvem medlemmene er,
          rollen til hver enkelt, og invitasjonskodene du lager.
        </li>
        <li>
          <strong>Hvert barn:</strong> navn, fødselsdato, og eventuelt kjønn
          (brukes kun til å tegne vekstpersentiler).
        </li>
        <li>
          <strong>Det du logger:</strong> måltider, bleier, søvn, lek, medisin,
          bad, notater, milepæler, målinger, pumping, vaksiner og
          kalenderhendelser — hver med tidspunkt og hvem som registrerte det.
        </li>
        <li>
          <strong>Varslingsinnstillinger</strong> og, hvis du slår på push, en
          abonnements-ID for nettleseren eller enheten din.
        </li>
      </List>

      <H>Helseopplysninger</H>
      <p>
        Noe av det du logger er helseopplysninger om et barn — vaksiner,
        medisin, vekt og lengde, og til dels selve mat- og søvnregistreringen.
        Europeisk personvernlovgivning regner dette som en særlig kategori som
        krever ekstra varsomhet, og vi ber om ditt uttrykkelige samtykke før du
        kan registrere det. Du kan når som helst trekke samtykket tilbake ved å
        slette opplysningene eller familien din.
      </p>

      <H>Hvorfor vi lagrer det, og på hvilket grunnlag</H>
      <List>
        <li>
          <strong>For å drive appen</strong> — vise deg det du har logget, på
          alle enheter familien din logger inn fra. Grunnlag: oppfyllelse av
          avtalen med deg, samt ditt uttrykkelige samtykke for
          helseopplysninger.
        </li>
        <li>
          <strong>For å sende påminnelser du har bedt om</strong> —
          måltidspåminnelser og kalenderpåminnelser, kun når du slår dem på.
          Grunnlag: ditt samtykke.
        </li>
        <li>
          <strong>For å holde tjenesten sikker</strong> — hastighetsbegrensning
          og en revisjonslogg over administrative handlinger. Grunnlag: vår
          berettigede interesse i å beskytte andre familiers opplysninger.
        </li>
      </List>
      <p>
        Vi driver ikke med reklame, vi profilerer deg ikke, og vi selger eller
        deler ikke opplysningene dine med noen for deres egne formål.
      </p>

      <H>Hvem andre behandler det</H>
      <p>
        Vi bruker et lite antall leverandører, hver under en
        databehandleravtale, og hver av dem gjør kun det vi instruerer:
      </p>
      <List>
        <li>
          <strong>Vår driftsleverandør</strong> — servere, database og
          fillagring, alt innenfor EU. Alle appdata ligger her.
        </li>
        <li>
          <strong>Google</strong> — kun hvis du velger å logge inn med Google.
        </li>
        <li>
          <strong>Nettleserens push-tjeneste</strong> (Apple, Google eller
          Mozilla, avhengig av enheten din) — kun hvis du slår på varsler, og
          kun for å levere selve varselet.
        </li>
      </List>

      <H>Hvor det lagres</H>
      <p>
        Opplysningene dine lagres innenfor EU. Der en leverandør er etablert
        utenfor EU, er overføringen dekket av EU-kommisjonens standard
        personvernbestemmelser (SCC).
      </p>

      <H>Hvor lenge vi beholder det</H>
      <p>
        Vi beholder det du logger så lenge familien din bruker Pjokk. Sletter du
        en oppføring, er den borte umiddelbart. Sletter du familien din, slettes
        alt som hører til den — hver logg, hvert barn, hver fil — umiddelbart.
      </p>
      <p>
        Vi tar en kryptert sikkerhetskopi én gang i døgnet og beholder den i{" "}
        <strong>30 dager</strong>. Det betyr at en sletting bruker inntil 30
        dager på å forsvinne helt ut av sikkerhetskopiene våre. Sikkerhetskopier
        brukes utelukkende til å gjenopprette tjenesten etter feil.
      </p>

      <H>Rettighetene dine</H>
      <p>Du kan når som helst, og gratis:</p>
      <List>
        <li>
          <strong>Få en kopi av alt</strong> — Innstillinger → Data → Eksporter
          CSV gir deg hver eneste oppføring som er registrert, én rad per
          oppføring.
        </li>
        <li>
          <strong>Rette hva som helst</strong> — hver oppføring kan redigeres i
          appen.
        </li>
        <li>
          <strong>Slette hva som helst</strong>, helt opp til hele familien din.
        </li>
        <li>
          <strong>Trekke tilbake samtykke</strong>, protestere mot behandlingen,
          eller be oss begrense den — skriv til {CONTACT}.
        </li>
      </List>
      <p>
        Mener du at vi behandler opplysningene dine feil, si gjerne fra til oss
        først, men du har også rett til å klage til Datatilsynet.
      </p>

      <H>Barn</H>
      <p>
        Pjokk brukes av voksne til å registrere opplysninger om sine egne barn.
        Barnet er den opplysningene gjelder, og en forelder eller foresatt
        utøver barnets rettigheter på dets vegne inntil barnet er gammelt nok
        til å gjøre det selv.
      </p>

      <H>Sikkerhet</H>
      <p>
        Hver forespørsel autentiseres og avgrenses til én familie; det finnes
        ingen vei der én familie kan lese en annen families opplysninger.
        Opplysningene er kryptert både under overføring og ved lagring. Skulle
        det oppstå et brudd som setter rettighetene dine i fare, varsler vi
        Datatilsynet innen 72 timer og sier fra til deg direkte der loven krever
        det.
      </p>

      <H>Endringer</H>
      <p>
        Endrer vi denne siden på en måte som har betydning, sier vi fra i appen
        før endringen trer i kraft.
      </p>
    </>
  );
}
