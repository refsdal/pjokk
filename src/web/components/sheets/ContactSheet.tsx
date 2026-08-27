import { IconMail, IconPhone, IconWorld } from "@tabler/icons-react";
import { useState } from "react";
import type { Contact, ContactIcon } from "@shared/schemas";
import { contactIcons } from "@shared/schemas";
import { MultiChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { contactIconMeta, websiteHref } from "@/lib/contact-ui";
import { useBabies, useDeleteContact, useSaveContact } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

// Reach the contact without leaving the sheet: the saved values, not the
// draft ones, so a half-typed number is never dialled.
function ContactActions({ contact }: { contact: Contact }) {
  const actions = [
    contact.phone && {
      key: "call",
      href: `tel:${contact.phone}`,
      icon: IconPhone,
      label: t("Call"),
    },
    contact.email && {
      key: "mail",
      href: `mailto:${contact.email}`,
      icon: IconMail,
      label: t("Email"),
    },
    contact.website && {
      key: "web",
      href: websiteHref(contact.website),
      icon: IconWorld,
      label: t("Website"),
    },
  ].filter((a) => !!a);

  if (actions.length === 0) return null;
  return (
    <div className="flex gap-2">
      {actions.map(({ key, href, icon: Icon, label }) => (
        <a
          key={key}
          href={href}
          target={key === "web" ? "_blank" : undefined}
          rel={key === "web" ? "noreferrer" : undefined}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl2 border border-line bg-surface text-sm font-semibold text-accent active:bg-surface-2"
        >
          <Icon className="h-5 w-5" />
          {label}
        </a>
      ))}
    </div>
  );
}

// ONE sheet for adding and editing a contact, mirroring BabySheet. Every
// field except the name is optional — a phone number scribbled under a name
// is a perfectly good contact.
export function ContactSheet({
  open,
  onOpenChange,
  contact = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
}) {
  const babies = useBabies();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [icon, setIcon] = useState<ContactIcon | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [notes, setNotes] = useState("");
  const [babyIds, setBabyIds] = useState<string[]>([]);
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setName(contact?.name ?? "");
    setRole(contact?.role ?? "");
    setIcon(contact?.icon ?? null);
    setPhone(contact?.phone ?? "");
    setEmail(contact?.email ?? "");
    setWebsite(contact?.website ?? "");
    setNotes(contact?.notes ?? "");
    setBabyIds(contact?.babies.map((b) => b.id) ?? []);
  }
  if (!open && wasOpen) setWasOpen(false);

  const save = useSaveContact(contact?.id);
  const remove = useDeleteContact();

  const trimmedEmail = email.trim();
  const submit = () => {
    save.mutate(
      {
        name: name.trim(),
        // Empty strings clear the field; the API takes null on PATCH and
        // omits on POST, so send undefined when creating.
        role: role.trim() || (contact ? null : undefined),
        icon: icon ?? (contact ? null : undefined),
        phone: phone.trim() || (contact ? null : undefined),
        email: trimmedEmail || (contact ? null : undefined),
        website: website.trim() || (contact ? null : undefined),
        notes: notes.trim() || (contact ? null : undefined),
        babyIds,
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "PLAN_REQUIRED") {
            toast(t("Premium feature — upgrade in Settings"), "error");
            return;
          }
          toast(err.message, "error");
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={contact ? t("Edit contact") : t("Add contact")}
    >
      <div className="space-y-5 pb-4">
        {contact && <ContactActions contact={contact} />}
        <Input
          placeholder={t("Name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder={t("Type (doctor, grandma, daycare…)")}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />

        <div className="flex flex-wrap gap-2">
          {contactIcons.map((key) => {
            const { icon: Icon, label } = contactIconMeta[key];
            const active = icon === key;
            return (
              <button
                key={key}
                type="button"
                aria-label={t(label)}
                aria-pressed={active}
                onClick={() => setIcon(active ? null : key)}
                className={
                  active
                    ? "flex h-11 w-11 items-center justify-center rounded-full border border-accent bg-accent text-on-accent"
                    : "flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink-soft active:bg-surface-2"
                }
              >
                <Icon className="h-5 w-5" />
              </button>
            );
          })}
        </div>

        <Input
          type="tel"
          placeholder={t("Phone")}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          type="email"
          placeholder={t("Email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="url"
          placeholder={t("Website")}
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
        <Input
          placeholder={t("Notes")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {(babies.data?.length ?? 0) > 1 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("Applies to")}
            </p>
            <MultiChipGroup
              options={(babies.data ?? []).map((b) => ({
                value: b.id,
                label: b.name,
              }))}
              values={babyIds}
              onToggle={(id) =>
                setBabyIds((prev) =>
                  prev.includes(id)
                    ? prev.filter((x) => x !== id)
                    : [...prev, id],
                )
              }
            />
            <p className="text-xs text-muted">
              {babyIds.length === 0
                ? t("Shared by the whole family.")
                : t("Only shown for the babies above.")}
            </p>
          </div>
        )}

        <Button
          size="full"
          onClick={submit}
          disabled={save.isPending || name.trim().length === 0}
        >
          {t("Save")}
        </Button>

        {contact && (
          <DeleteButton
            onDelete={() =>
              remove.mutate(contact.id, {
                onSuccess: () => {
                  toast(t("Contact removed"));
                  onOpenChange(false);
                },
                onError: (err) => toast(err.message, "error"),
              })
            }
          />
        )}
      </div>
    </Sheet>
  );
}
