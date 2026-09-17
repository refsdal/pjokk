import { IconPlus, IconUsers } from "@tabler/icons-react";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { BabySheet } from "@/components/sheets/BabySheet";
import { Card } from "@/components/ui/card";
import { useBabies, useMe, useMembers } from "@/lib/data";
import { t } from "@/lib/i18n";
import { legalUrl } from "@/lib/site";
import { formatAge } from "@/lib/time";
import { NavRow, SectionTitle } from "./lib";

// Settings is a hub, not a list: what belongs to the family, what belongs
// to one child, and a pointer to what belongs to you (which lives on
// /profile, behind your face, where the person already was). The old
// screen was twenty sections in the order they shipped, and its per-baby
// cards acted on whichever baby Home had selected without saying so.
export function SettingsScreen() {
  const me = useMe();
  const babies = useBabies();
  const members = useMembers();
  const [adding, setAdding] = useState(false);
  const caretakers = members.data?.length ?? 0;

  return (
    <div className="mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6">
      <h1 className="py-4 text-2xl font-extrabold text-ink">{t("Settings")}</h1>
      <div className="pb-tabbar">
        <SectionTitle>{t("Family")}</SectionTitle>
        <Card className="p-0">
          <NavRow
            to="/settings/family"
            label={t("Family")}
            sub={
              caretakers > 0
                ? `${caretakers} ${caretakers === 1 ? t("caretaker") : t("caretakers")} · ${t("shared lists · data")}`
                : t("shared lists · data")
            }
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-soft">
                <IconUsers className="h-5 w-5" />
              </span>
            }
          />
        </Card>

        <SectionTitle>{t("Babies")}</SectionTitle>
        <Card className="divide-y divide-line p-0">
          {(babies.data ?? []).map((b) => (
            <NavRow
              key={b.id}
              to="/settings/baby/$babyId"
              params={{ babyId: b.id }}
              label={b.name}
              sub={`${formatAge(new Date(b.birthDate))}${b.sex ? "" : ` · ${t("sex not set")}`}`}
              leading={<Avatar src={null} name={b.name} size={9} />}
            />
          ))}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left font-semibold text-ink-soft active:bg-surface-2"
          >
            <IconPlus className="h-5 w-5" />
            {t("Add baby")}
          </button>
        </Card>
        <BabySheet open={adding} onOpenChange={setAdding} />

        <SectionTitle>{t("You")}</SectionTitle>
        <Card className="p-0">
          <NavRow
            to="/profile"
            label={me.data?.displayName || me.data?.email || t("Your profile")}
            sub={t("Notifications · appearance · account")}
            leading={
              <Avatar
                src={me.data?.avatarUrl}
                name={me.data?.displayName || me.data?.email || "?"}
                size={9}
              />
            }
          />
        </Card>

        <SectionTitle>{t("About")}</SectionTitle>
        <Card className="divide-y divide-line p-0">
          {/* Plain anchors, not <Link>: these pages left the SPA in the
              landing split (PR #17) and now live on the public apex, where
              they are prerendered and readable without an account. */}
          <a
            href={legalUrl("privacy")}
            className="block px-4 py-3 font-semibold text-ink active:bg-surface-2"
          >
            {t("Privacy policy")}
          </a>
          <a
            href={legalUrl("terms")}
            className="block px-4 py-3 font-semibold text-ink active:bg-surface-2"
          >
            {t("Terms")}
          </a>
        </Card>

        <p className="py-6 text-center text-xs text-muted">
          <a href="/api/docs" className="underline">
            {t("API docs")}
          </a>
          {/* The server's build version — the image tag, not a number kept
              by hand (internal/buildinfo). */}
          {me.data ? ` · Pjokk ${me.data.version}` : null}
        </p>
      </div>
    </div>
  );
}
