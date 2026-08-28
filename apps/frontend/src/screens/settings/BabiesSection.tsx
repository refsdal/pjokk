import { IconLock, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import type { Baby } from "@pjokk/shared";
import { BabySheet } from "@/components/sheets/BabySheet";
import { Card } from "@/components/ui/card";
import { useBabies, usePremium } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { formatAge } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./lib";

export function BabiesSection({ isAdmin }: { isAdmin: boolean }) {
  const babies = useBabies();
  const premium = usePremium();
  const atLimit = !premium && (babies.data?.length ?? 0) >= 1;
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
          onClick={
            atLimit
              ? () => {
                  toast(t("Premium feature — upgrade in Settings"));
                  document
                    .getElementById("billing")
                    ?.scrollIntoView({ behavior: "smooth" });
                }
              : () => setAdding(true)
          }
          className={cn(
            "flex w-full items-center gap-2 px-4 py-3 text-left font-semibold text-ink-soft active:bg-surface-2",
            atLimit && "text-muted opacity-60",
          )}
        >
          {atLimit ? (
            <IconLock className="h-5 w-5" />
          ) : (
            <IconPlus className="h-5 w-5" />
          )}
          {t("Add baby")}
          {atLimit && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
              {t("Premium")}
            </span>
          )}
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
