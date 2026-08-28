import { IconLock, IconPhone, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import type { Contact } from "@pjokk/shared";
import { ContactSheet } from "@/components/sheets/ContactSheet";
import { Card } from "@/components/ui/card";
import { contactIconFor } from "@/lib/contact-ui";
import { useContacts, usePremium } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./lib";

export function ContactsSection() {
  const contacts = useContacts();
  const premium = usePremium();
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = contacts.data ?? [];

  return (
    <>
      <SectionTitle>{t("Contacts")}</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {rows.map((c) => (
          <ContactRow key={c.id} contact={c} onEdit={() => setEditContact(c)} />
        ))}

        {rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted">
            {t("Doctor, helsestasjon, grandparents — the people you call.")}
          </p>
        )}

        <button
          type="button"
          onClick={
            premium
              ? () => setAdding(true)
              : () => {
                  toast(t("Premium feature — upgrade in Settings"));
                  document
                    .getElementById("billing")
                    ?.scrollIntoView({ behavior: "smooth" });
                }
          }
          className={cn(
            "flex w-full items-center gap-2 px-4 py-3 text-left font-semibold text-ink-soft active:bg-surface-2",
            !premium && "text-muted opacity-60",
          )}
        >
          {premium ? (
            <IconPlus className="h-5 w-5" />
          ) : (
            <IconLock className="h-5 w-5" />
          )}
          {t("Add contact")}
          {!premium && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
              {t("Premium")}
            </span>
          )}
        </button>
      </Card>

      <ContactSheet
        open={!!editContact}
        onOpenChange={(o) => !o && setEditContact(null)}
        contact={editContact}
      />
      <ContactSheet open={adding} onOpenChange={setAdding} />
    </>
  );
}

// Tapping the row edits (same idiom as Babies), but a contact with a number
// gets a dedicated call target — the thing you actually want at 2 a.m. The
// anchor is a sibling of the button, never nested inside it.
function ContactRow({
  contact,
  onEdit,
}: {
  contact: Contact;
  onEdit: () => void;
}) {
  const Icon = contactIconFor(contact.icon);
  const detail = [
    contact.role,
    // No baby chips = shared by the whole family, which needs no label.
    contact.babies.length > 0
      ? contact.babies.map((b) => b.name).join(", ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={onEdit}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-ink">
            {contact.name}
          </span>
          {detail && (
            <span className="block truncate text-sm text-muted">{detail}</span>
          )}
        </span>
      </button>
      {contact.phone && (
        <a
          href={`tel:${contact.phone}`}
          aria-label={`${t("Call")} ${contact.name}`}
          className="flex w-14 shrink-0 items-center justify-center text-accent active:bg-surface-2"
        >
          <IconPhone className="h-5 w-5" />
        </a>
      )}
    </div>
  );
}
