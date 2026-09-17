import type { Baby } from "@pjokk/shared";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { AccountSheet } from "@/components/sheets/AccountSheet";
import { useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatAge } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

// One header for every baby screen (Home, Timeline, Stats, Vaccines): the
// babies on the left, the caretaker's own face on the right, identical
// wherever it is so the eye never has to look for it. Calendar and Settings
// are family-wide and carry no baby, so they render neither.
//
// The row is a segmented control of faces in a FIXED order (the list's:
// oldest first, the order Settings → Babies uses): the selected baby is a
// pill with name and age inside, the others are bare faces beside it, and
// tapping a face makes it the pill. Fixed rather than "current first" so
// each child keeps a fixed spot under the thumb — the ring says which is
// current, the position never moves. Switching is one tap; the picker
// sheet it replaced took two. Adding a baby lives in Settings → Babies.

export function BabyRow({
  babies,
  selectedId,
  onSelect,
}: {
  babies: Baby[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (babies.length === 1) {
    // Nothing to switch between: a heading, not a control.
    const b = babies[0]!;
    return (
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar src={b.avatarUrl} name={b.name} size={11} />
        <BabyLabel baby={b} />
      </div>
    );
  }
  return (
    // p-0.5 -m-0.5: the row scrolls (a fifth baby), so it clips, and the
    // selected pill's 2 px ring is drawn outside its box — the padding is
    // the ring's room on every side, the negative margin keeps the layout.
    <fieldset
      aria-label={t("Babies")}
      className="-m-0.5 flex min-w-0 items-center gap-2 overflow-x-auto p-0.5"
    >
      {babies.map((b) => {
        const on = b.id === selectedId;
        return on ? (
          <button
            key={b.id}
            type="button"
            aria-pressed
            onClick={() => onSelect(b.id)}
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-full bg-surface-2 py-1 pr-4 pl-1 text-left ring-2 ring-accent",
              focusRing,
            )}
          >
            <Avatar src={b.avatarUrl} name={b.name} size={9} />
            <BabyLabel baby={b} />
          </button>
        ) : (
          <button
            key={b.id}
            type="button"
            aria-pressed={false}
            aria-label={b.name}
            onClick={() => onSelect(b.id)}
            className={cn(
              "shrink-0 rounded-full opacity-70 active:scale-95",
              focusRing,
            )}
          >
            <Avatar src={b.avatarUrl} name={b.name} size={11} />
          </button>
        );
      })}
    </fieldset>
  );
}

function BabyLabel({ baby }: { baby: Baby }) {
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-[15px] font-bold text-ink">
        {baby.name}
      </span>
      <span className="truncate text-xs font-medium text-muted">
        {formatAge(new Date(baby.birthDate))}
      </span>
    </span>
  );
}

export function BabyHeader() {
  const me = useMe();
  const { babies, baby, selectBaby } = useSelectedBaby();
  const [account, setAccount] = useState(false);
  return (
    <header className="flex items-center justify-between gap-3 py-3">
      {baby ? (
        <BabyRow
          babies={babies.data ?? []}
          selectedId={baby.id}
          onSelect={selectBaby}
        />
      ) : (
        <span />
      )}
      <button
        type="button"
        aria-label={t("Account")}
        onClick={() => setAccount(true)}
        className={cn("shrink-0 rounded-full active:scale-95", focusRing)}
      >
        <Avatar
          src={me.data?.avatarUrl}
          name={me.data?.displayName ?? "?"}
          size={11}
        />
      </button>
      <AccountSheet open={account} onOpenChange={setAccount} />
    </header>
  );
}
