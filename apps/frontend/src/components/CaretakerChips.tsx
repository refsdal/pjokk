import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useMe, useMembers } from "@/lib/data/family";
import {
  caretakerField,
  caretakerOptions,
  firstName,
  loggedByLine,
} from "@/lib/caretaker-ui";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

// Who did the care (spec docs/superpowers/specs/2026-09-14-who-did-it-
// design.md): the family's faces in every log sheet, between the time and
// the note. Yourself is the default, so the two-tap happy path is untouched;
// the row is not rendered at all for a family of one. On an edit the chips
// start on the entry's caretaker, and a muted "Logged by" line says who
// saved it when that was somebody else.

// A sheet holds its choice through this hook: `reset` goes in its
// useSheetReset callback, `field()` is spread into the create body or the
// PATCH, `value` is what the chips show. `edit` is the row being edited,
// whose caretaker is the baseline; null on create means yourself.
export function useCaretakerChoice(
  edit: { caretakerId: string } | null | undefined,
) {
  const me = useMe();
  const [chosen, setChosen] = useState<string | null>(null);
  const baseline = edit?.caretakerId ?? me.data?.userId ?? null;
  return {
    value: chosen ?? baseline,
    choose: setChosen,
    reset: () => setChosen(null),
    field: () => caretakerField(chosen, baseline),
  };
}

export type CaretakerChoice = ReturnType<typeof useCaretakerChoice>;

export function CaretakerChips({
  choice,
  edit = null,
  label = "Who",
  testId = "caretaker-chips",
}: {
  // Only `value` and `choose` are read here, so a sheet with a second
  // person on it (the barnehage pick-up) can hand in a choice of its own.
  choice: Pick<CaretakerChoice, "value" | "choose">;
  edit?: { loggedById: string; loggedByName: string } | null;
  // The row's heading, an i18n key. "Who" everywhere but that second row.
  label?: string;
  testId?: string;
}) {
  const me = useMe();
  const members = useMembers();
  const faces = caretakerOptions(members.data ?? [], me.data?.userId);
  if (faces.length < 2) return null;
  const loggedBy = loggedByLine(edit, choice.value);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        {t(label)}
      </p>
      <fieldset
        aria-label={t(label)}
        className="flex gap-2 overflow-x-auto"
        data-testid={testId}
      >
        {faces.map((m) => {
          const on = m.userId === choice.value;
          return (
            <button
              key={m.userId}
              type="button"
              aria-pressed={on}
              onClick={() => choice.choose(m.userId)}
              className={cn(
                "flex h-11 shrink-0 items-center gap-2 rounded-full border py-1 pr-4 pl-1 text-sm font-semibold transition-colors select-none active:scale-[0.97]",
                focusRing,
                on
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-line bg-surface text-ink-soft",
              )}
            >
              <Avatar src={m.avatarUrl} name={m.name || m.email} size={8} />
              {firstName(m)}
            </button>
          );
        })}
      </fieldset>
      {loggedBy && (
        <p className="text-xs text-muted" data-testid="logged-by">
          {t("Logged by")} {loggedBy}
        </p>
      )}
    </div>
  );
}
