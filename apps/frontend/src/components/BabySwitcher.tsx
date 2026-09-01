import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { BabySheet } from "@/components/sheets/BabySheet";
import { Sheet } from "@/components/Sheet";
import { t } from "@/lib/i18n";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatAge } from "@/lib/time";
import { cn } from "@/lib/utils";

// The baby's name is the switcher: with one baby it's just a heading, with
// several it opens a picker. `compact` renders the small header-corner chip
// used on Timeline/Stats.
export function BabySwitcher({ compact = false }: { compact?: boolean }) {
  const { babies, baby, selectBaby } = useSelectedBaby();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const many = (babies.data?.length ?? 0) > 1;

  if (!baby) return null;

  const trigger = compact ? (
    <button
      type="button"
      onClick={() => many && setOpen(true)}
      className={cn(
        "flex h-9 items-center gap-1 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-ink",
        !many && "pointer-events-none border-transparent bg-transparent",
      )}
    >
      {baby.name}
      {many && <IconChevronDown className="h-4 w-4 text-muted" />}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => many && setOpen(true)}
      className={cn(
        "flex items-center gap-1.5 text-left",
        !many && "pointer-events-none",
      )}
    >
      <span>
        <span className="block text-2xl font-extrabold text-ink">
          {baby.name}
        </span>
        <span className="block text-sm font-medium text-muted">
          {formatAge(new Date(baby.birthDate))}
        </span>
      </span>
      {many && <IconChevronDown className="h-5 w-5 text-muted" />}
    </button>
  );

  return (
    <>
      {trigger}
      <Sheet open={open} onOpenChange={setOpen} title={t("Switch baby")}>
        <div className="space-y-2 pb-4">
          {(babies.data ?? []).map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={b.id === baby.id}
              onClick={() => {
                selectBaby(b.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-xl2 border px-4 py-3 text-left",
                b.id === baby.id
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface active:bg-surface-2",
              )}
            >
              <span className="font-semibold text-ink">{b.name}</span>
              <span className="text-sm text-muted">
                {formatAge(new Date(b.birthDate))}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
            className="flex w-full items-center gap-2 rounded-xl2 border border-dashed border-line px-4 py-3 text-left font-semibold text-ink-soft active:bg-surface-2"
          >
            <IconPlus className="h-5 w-5" />
            {t("Add baby")}
          </button>
        </div>
      </Sheet>
      <BabySheet open={adding} onOpenChange={setAdding} />
    </>
  );
}
