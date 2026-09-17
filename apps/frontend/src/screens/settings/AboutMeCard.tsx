import { IconFileTypePdf } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { Baby, BabyAbout } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  type AboutSectionKey,
  aboutSections,
  foodRoutine,
  sleepRoutine,
} from "@/lib/about-me";
import { useAboutMe, useSaveBabyAbout } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { formatVolume, useUnits } from "@/lib/units";
import { cn, focusRing } from "@/lib/utils";

// Settings → <baby> → "About <name>" (issue #109): the one page a barnehage
// asks every family for before tilvenning. Most of it is already in the
// logs; the four lines the logs cannot know are typed here and kept beside
// the baby. The preview IS the page: every section can be left out before
// anything is made, and nothing leaves the device but the file the parent
// chooses to print or send.
const FIELDS: { key: keyof BabyAbout; label: string; hint: string }[] = [
  {
    key: "comfort",
    label: "Comfort items",
    hint: "Dummy, cuddly toy, blanket…",
  },
  {
    key: "fallsAsleep",
    label: "Falls asleep",
    hint: "Rocked in the pram, a song, on her tummy…",
  },
  {
    key: "diet",
    label: "Allergies and diet",
    hint: "Milk allergy, no pork, still breastfed mornings…",
  },
  {
    key: "other",
    label: "Also worth knowing",
    hint: "Shy with new people, loves the sandpit…",
  },
];

export function AboutMeCard({ baby }: { baby: Baby }) {
  const units = useUnits();
  const data = useAboutMe(baby.id);
  const save = useSaveBabyAbout();
  const [text, setText] = useState<BabyAbout | null>(null);
  const [left, setLeft] = useState<Set<AboutSectionKey>>(new Set());
  const [busy, setBusy] = useState(false);

  // Seed the fields once per baby, from the server; typing owns them after.
  const babyId = baby.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed only when the baby changes or its text first arrives
  useEffect(() => {
    setText(data.about ?? null);
  }, [babyId, data.about !== undefined]);

  const about = text ?? {
    comfort: null,
    fallsAsleep: null,
    diet: null,
    other: null,
  };
  const sections = aboutSections({
    about,
    sleep: sleepRoutine(data.sleeps),
    food: foodRoutine(data.feeds),
    medicines: data.medicines,
    contacts: data.contacts,
    volume: (ml) => formatVolume(Math.round(ml / 5) * 5, units),
    t,
  });
  const printed = sections.filter((s) => !left.has(s.key));

  const make = async () => {
    setBusy(true);
    try {
      await save.mutateAsync({ babyId: baby.id, about });
      const { buildAboutPdf } = await import("@/lib/about-me-pdf");
      await buildAboutPdf({ baby, sections: printed });
    } catch (err) {
      toast(
        `${t("Could not build the page")}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4" data-testid="about-me">
      <p className="text-sm text-muted">
        {t(
          "One page for the barnehage: routines from your logs, plus what only you know. Built on this device. Leave out any part before you make it.",
        )}
      </p>

      {FIELDS.map((f) => (
        <label key={f.key} className="block space-y-1">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t(f.label)}
          </span>
          <textarea
            rows={2}
            maxLength={500}
            placeholder={t(f.hint)}
            value={about[f.key] ?? ""}
            onChange={(e) => setText({ ...about, [f.key]: e.target.value })}
            className="w-full rounded-xl2 border border-line bg-surface px-4 py-3 text-base text-ink placeholder:text-muted"
          />
        </label>
      ))}

      {sections.length > 0 && (
        <div className="space-y-3 border-t border-line pt-4">
          {sections.map((s) => {
            const on = !left.has(s.key);
            return (
              <div key={s.key} className={cn("space-y-1", !on && "opacity-50")}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() =>
                    setLeft((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(s.key);
                      else next.delete(s.key);
                      return next;
                    })
                  }
                  className={cn(
                    "flex min-h-11 w-full items-center justify-between gap-3 text-left",
                    focusRing,
                  )}
                >
                  <span className="text-sm font-bold text-ink">{s.title}</span>
                  <span className="text-xs font-semibold text-accent">
                    {on ? t("Included") : t("Left out")}
                  </span>
                </button>
                {on &&
                  s.lines.map((l) => (
                    <p key={l.label} className="text-sm text-ink-soft">
                      <span className="font-semibold text-ink">{l.label}:</span>{" "}
                      {l.value}
                    </p>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      <Button
        size="full"
        variant="outline"
        disabled={busy || data.loading}
        onClick={() => void make()}
      >
        <span className="inline-flex items-center gap-1.5">
          <IconFileTypePdf className="h-4 w-4" />
          {busy ? t("Building…") : `${t("Make the page")} · ${baby.name}`}
        </span>
      </Button>
    </Card>
  );
}
