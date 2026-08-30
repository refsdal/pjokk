import { ADDRESS_EN, ADDRESS_NB, COMPANY, H, ORG_NR } from "./layout";

export function En() {
  return (
    <>
      <p>
        These terms cover your use of Pjokk at pjokk.no, operated by {COMPANY}{" "}
        (org. nr. {ORG_NR}), {ADDRESS_EN}. By creating an account you accept
        them.
      </p>

      <H>What Pjokk is</H>
      <p>
        A tool for recording and looking back at a child's daily care. It is a
        notebook, not a medical device.
      </p>

      <H>Pjokk is not medical advice</H>
      <p>
        Nothing in Pjokk is medical advice, and nothing in it should be used to
        make a medical decision. Where we show a vaccination schedule, we are
        repeating what Folkehelseinstituttet publishes and linking to their
        pages — we make no statement of our own about any vaccine, treatment or
        medicine. Growth percentiles are drawn from published WHO reference data
        and are a picture, not a diagnosis. Reminders are a convenience and may
        be late or fail to arrive. Talk to your helsestasjon, your doctor, or
        emergency services — not to an app.
      </p>

      <H>Accounts</H>
      <p>
        Pjokk is invite-only: accounts are created by redeeming an invite from
        an existing family. Keep your sign-in details to yourself, and only
        invite people you intend to give full access to your family's records.
        Anyone you invite as an admin can delete data and invite others.
      </p>

      <H>Your data is yours</H>
      <p>
        You keep every right to what you record. We claim no ownership of it and
        will not use it for anything except running the service for you. You can
        export it or delete it whenever you like.
      </p>

      <H>Acceptable use</H>
      <p>
        Do not use Pjokk to store other people's information without their
        knowledge, to break the law, or to attack or overload the service. We
        may suspend an account that does.
      </p>

      <H>Paid plans</H>
      <p>
        Some features require a Premium plan. Subscriptions are billed monthly
        or yearly through Stripe and renew until cancelled; a lifetime plan is a
        single payment. You can cancel at any time from Settings → Billing, and
        keep access until the period you have paid for ends. If a plan lapses
        you keep access to everything you already recorded — you can still read,
        edit, export and delete it — you simply cannot create new entries of the
        premium kinds.
      </p>
      <p>
        As Norwegian consumer law provides, you have a 14-day right to withdraw
        from a purchase. Asking us to start immediately means that right ends
        once the service has been fully delivered.
      </p>

      <H>Availability</H>
      <p>
        Pjokk is early software offered as it is. We do not promise it will be
        available without interruption or free of faults, and we may change or
        withdraw features. We take backups but you should not treat Pjokk as the
        only copy of anything you cannot bear to lose — that is what the CSV
        export is for.
      </p>

      <H>Liability</H>
      <p>
        To the extent the law allows, we are not liable for indirect or
        consequential loss arising from your use of Pjokk. Nothing here limits
        liability that cannot be limited by law, including for death or personal
        injury caused by negligence, or for our own gross negligence or intent.
        Nothing here limits your rights under mandatory Norwegian consumer law.
      </p>

      <H>Ending it</H>
      <p>
        You can delete your family and stop using Pjokk at any time. We may
        close an account that breaks these terms, and will tell you why unless
        the law prevents us.
      </p>

      <H>Law</H>
      <p>
        Norwegian law applies, and disputes belong to the Norwegian courts. This
        does not remove any protection you have under the mandatory law of the
        country you live in.
      </p>

      <H>Changes</H>
      <p>
        We will tell you in the app before a material change to these terms
        takes effect.
      </p>
    </>
  );
}

export function Nb() {
  return (
    <>
      <p>
        Disse vilkårene gjelder din bruk av Pjokk på pjokk.no, drevet av{" "}
        {COMPANY} (org.nr. {ORG_NR}), {ADDRESS_NB}. Ved å opprette en konto
        godtar du dem.
      </p>

      <H>Hva Pjokk er</H>
      <p>
        Et verktøy for å registrere og se tilbake på et barns daglige omsorg.
        Det er en notatbok, ikke medisinsk utstyr.
      </p>

      <H>Pjokk er ikke medisinske råd</H>
      <p>
        Ingenting i Pjokk er medisinske råd, og ingenting i appen skal brukes
        til å ta en medisinsk beslutning. Der vi viser et vaksinasjonsprogram,
        gjengir vi det Folkehelseinstituttet publiserer og lenker til deres
        sider — vi kommer ikke med egne påstander om noen vaksine, behandling
        eller medisin. Vekstpersentiler er tegnet fra publiserte referansedata
        fra WHO og er et bilde, ikke en diagnose. Påminnelser er en
        bekvemmelighet og kan komme for sent eller utebli. Snakk med
        helsestasjonen, legen din eller nødetatene — ikke med en app.
      </p>

      <H>Kontoer</H>
      <p>
        Pjokk er kun for inviterte: kontoer opprettes ved å løse inn en
        invitasjon fra en eksisterende familie. Hold påloggingsopplysningene
        dine for deg selv, og inviter bare folk du faktisk vil gi full tilgang
        til familiens registreringer. Alle du inviterer som administrator kan
        slette data og invitere andre.
      </p>

      <H>Dine data er dine</H>
      <p>
        Du beholder alle rettigheter til det du registrerer. Vi gjør ikke krav
        på eierskap, og vi bruker det ikke til noe annet enn å drive tjenesten
        for deg. Du kan eksportere eller slette det når du vil.
      </p>

      <H>Akseptabel bruk</H>
      <p>
        Ikke bruk Pjokk til å lagre andres opplysninger uten at de vet om det,
        til å bryte loven, eller til å angripe eller overbelaste tjenesten. Vi
        kan sperre en konto som gjør det.
      </p>

      <H>Betalte planer</H>
      <p>
        Enkelte funksjoner krever Premium. Abonnementer faktureres månedlig
        eller årlig gjennom Stripe og fornyes til de sies opp; en livstidsplan
        er en engangsbetaling. Du kan si opp når som helst under Innstillinger →
        Betaling, og beholder tilgangen ut perioden du har betalt for. Utløper
        en plan, beholder du tilgangen til alt du allerede har registrert — du
        kan fortsatt lese, redigere, eksportere og slette det — du kan bare ikke
        opprette nye oppføringer av premium-typene.
      </p>
      <p>
        Som norsk forbrukerlovgivning fastsetter, har du 14 dagers angrerett ved
        kjøp. Ber du oss starte leveringen umiddelbart, faller angreretten bort
        når tjenesten er levert i sin helhet.
      </p>

      <H>Tilgjengelighet</H>
      <p>
        Pjokk er tidlig programvare som tilbys som den er. Vi lover ikke at den
        er tilgjengelig uten avbrudd eller fri for feil, og vi kan endre eller
        fjerne funksjoner. Vi tar sikkerhetskopier, men du bør ikke behandle
        Pjokk som eneste kopi av noe du ikke tåler å miste — det er det
        CSV-eksporten er til for.
      </p>

      <H>Ansvar</H>
      <p>
        Så langt loven tillater, er vi ikke ansvarlige for indirekte tap eller
        følgetap som følge av din bruk av Pjokk. Ingenting her begrenser ansvar
        som ikke kan begrenses etter loven, herunder for dødsfall eller
        personskade voldt ved uaktsomhet, eller for vår egen grove uaktsomhet
        eller forsett. Ingenting her begrenser rettighetene dine etter
        ufravikelig norsk forbrukerlovgivning.
      </p>

      <H>Avslutning</H>
      <p>
        Du kan slette familien din og slutte å bruke Pjokk når som helst. Vi kan
        stenge en konto som bryter disse vilkårene, og vil si fra hvorfor med
        mindre loven hindrer oss.
      </p>

      <H>Lovvalg</H>
      <p>
        Norsk rett gjelder, og tvister hører inn under norske domstoler. Dette
        fjerner ikke beskyttelse du har etter ufravikelig lovgivning i landet du
        bor i.
      </p>

      <H>Endringer</H>
      <p>
        Vi sier fra i appen før en vesentlig endring i disse vilkårene trer i
        kraft.
      </p>
    </>
  );
}
