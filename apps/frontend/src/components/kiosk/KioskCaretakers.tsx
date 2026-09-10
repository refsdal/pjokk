import type { Member } from "@pjokk/shared";
import { Avatar } from "@/components/Avatar";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

// Who is logging on a kiosk device (spec 2026-09-10-kiosk-devices §6): the
// family's faces under the band. Attribution only — choosing someone grants
// nothing, and there is no per-person PIN. The choice clears when the kiosk
// dims; with nobody chosen, an action asks first (KioskWhoPrompt).

// A first name is what a finger looks for across the room. Someone who
// signed up without a name (the e-mail signup path has none) still needs a
// label, so they get the part of their address before the @.
function label(m: Member): string {
  const name = m.name.trim();
  return name
    ? (name.split(/\s+/)[0] ?? name)
    : (m.email.split("@")[0] ?? m.email);
}

export function KioskCaretakers({
  members,
  selected,
  onSelect,
}: {
  members: Member[];
  selected: string | null;
  onSelect: (userId: string) => void;
}) {
  return (
    <fieldset
      aria-label={t("Who's logging?")}
      className="flex min-w-0 items-center gap-3 overflow-x-auto pt-4"
      data-testid="kiosk-caretakers"
    >
      {!selected && (
        <p className="shrink-0 text-sm font-semibold text-muted">
          {t("Who's logging?")}
        </p>
      )}
      {members.map((m) => {
        const on = m.userId === selected;
        return (
          <button
            key={m.userId}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(m.userId)}
            className={cn(
              "flex h-[52px] shrink-0 items-center gap-2 rounded-full py-1 pr-4 pl-1",
              on ? "bg-surface-2 ring-2 ring-accent" : "opacity-70",
              focusRing,
            )}
          >
            <Avatar src={m.avatarUrl} name={m.name || m.email} size={11} />
            <span className="text-[15px] font-semibold text-ink">
              {label(m)}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

// Tapping an action with nobody chosen opens this; choosing completes the
// action, so it is still one decision, not a lost tap.
export function KioskWhoPrompt({
  members,
  onSelect,
  onCancel,
}: {
  members: Member[];
  onSelect: (userId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Who's logging?")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    >
      <div className="flex w-full max-w-xl flex-col items-center gap-6 rounded-3xl border border-line bg-bg px-8 pt-7 pb-6">
        <p className="text-xl font-bold text-ink">{t("Who's logging?")}</p>
        <div className="flex flex-wrap justify-center gap-6">
          {members.map((m) => (
            <button
              key={m.userId}
              type="button"
              onClick={() => onSelect(m.userId)}
              className={cn(
                "flex w-24 flex-col items-center gap-2 rounded-2xl p-2 active:scale-95",
                focusRing,
              )}
            >
              <Avatar src={m.avatarUrl} name={m.name || m.email} size={20} />
              <span className="max-w-full truncate text-[15px] font-semibold text-ink">
                {label(m)}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "h-11 px-4 text-sm font-semibold text-muted",
            focusRing,
          )}
        >
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}
