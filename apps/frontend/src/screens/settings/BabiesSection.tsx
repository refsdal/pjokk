import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import type { Baby } from "@pjokk/shared";
import { BabySheet } from "@/components/sheets/BabySheet";
import { Card } from "@/components/ui/card";
import { useBabies } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatAge } from "@/lib/time";
import { SectionTitle } from "./lib";

export function BabiesSection({ isAdmin }: { isAdmin: boolean }) {
  const babies = useBabies();
  const [editBaby, setEditBaby] = useState<Baby | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <SectionTitle>{t("Babies")}</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {(babies.data ?? []).map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setEditBaby(b)}
            className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-surface-2"
          >
            <p className="font-semibold text-ink">{b.name}</p>
            <p className="text-sm text-muted">
              {formatAge(new Date(b.birthDate))}
              {b.sex ? "" : ` · ${t("sex not set")}`}
            </p>
          </button>
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
      <BabySheet
        open={!!editBaby}
        onOpenChange={(o) => !o && setEditBaby(null)}
        baby={editBaby}
        canDelete={isAdmin}
      />
      <BabySheet open={adding} onOpenChange={setAdding} />
    </>
  );
}
