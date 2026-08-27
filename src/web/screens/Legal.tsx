import { IconArrowLeft } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";

// Public, deliberately: someone deciding whether to accept an invite — and a
// supervisory authority — must be able to read these without an account.
//
// Written in English and NOT routed through t(): the i18n dictionary is for
// short UI strings, and a policy split across hundreds of keys would rot.
// A Norwegian version is outstanding and matters legally for Norwegian
// users; see DECISIONS.md.
//
// STILL OUTSTANDING before these are relied upon (see the PR checklist):
//   - a Norwegian version
//   - review by someone qualified — these were drafted by an AI
// Done: the contact mailbox is live, the company details below are real, and
// D1/R2 are pinned to the EU jurisdiction, so the storage claim is true.

const UPDATED = "27 August 2026";
const CONTACT = "personvern@pjokk.no";
const COMPANY = "Refsdal Holding AS";
const ORG_NR = "932 516 470";
const ADDRESS = "Marstrandgata 13B, 0566 Oslo, Norway";

function LegalPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pt-safe pb-16">
      <div className="flex items-center gap-2 py-4">
        <button
          type="button"
          aria-label="Back"
          onClick={() => router.history.back()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink active:bg-surface-2"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-2xl font-extrabold text-ink">{title}</h1>
      </div>
      <p className="pb-6 text-sm text-muted">Last updated {UPDATED}</p>
      <div className="space-y-6 text-[15px] leading-relaxed text-ink-soft">
        {children}
      </div>
      <nav className="mt-10 flex gap-4 border-t border-line pt-6 text-sm font-semibold text-accent">
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <Link to="/">Back to Pjokk</Link>
      </nav>
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h2 className="pt-2 text-lg font-bold text-ink">{children}</h2>;
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

export function PrivacyScreen() {
  return (
    <LegalPage title="Privacy">
      <p>
        Pjokk is a baby tracker. Using it means recording information about a
        child's daily care, and some of that is health information. This page
        explains exactly what we store, why, who else can see it, and how to get
        it back or have it deleted.
      </p>

      <H>Who is responsible</H>
      <p>
        {COMPANY} is the data controller for the information you put into Pjokk
        at app.pjokk.no.
      </p>
      <p className="text-sm text-muted">
        {COMPANY}
        <br />
        Org. nr. {ORG_NR}
        <br />
        {ADDRESS}
        <br />
        <a href={`mailto:${CONTACT}`} className="font-semibold text-accent">
          {CONTACT}
        </a>
      </p>

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
        <li>
          <strong>Billing:</strong> if you subscribe, Stripe handles the payment
          and we store only the resulting subscription status. We never see or
          store your card number.
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
          <strong>To take payment</strong>, if you subscribe. Basis: our
          agreement with you.
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
          <strong>Cloudflare</strong> — hosting, database, file storage. All
          application data lives here.
        </li>
        <li>
          <strong>Stripe</strong> — payments, if you subscribe.
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
    </LegalPage>
  );
}

export function TermsScreen() {
  return (
    <LegalPage title="Terms">
      <p>
        These terms cover your use of Pjokk at app.pjokk.no, operated by{" "}
        {COMPANY} (org. nr. {ORG_NR}), {ADDRESS}. By creating an account you
        accept them.
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
    </LegalPage>
  );
}
