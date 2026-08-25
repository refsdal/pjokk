import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Baby } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { useBabies } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatAge, toLocalDateInput } from "@/lib/time";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

function BabyEditSheet({
  baby,
  onOpenChange,
}: {
  baby: Baby | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [sex, setSex] = useState<"girl" | "boy" | null>(null);
  const [wasOpen, setWasOpen] = useState(false);

  if (baby && !wasOpen) {
    setWasOpen(true);
    setName(baby.name);
    setBirthDate(toLocalDateInput(new Date(baby.birthDate)));
    setSex(baby.sex);
  }
  if (!baby && wasOpen) setWasOpen(false);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.babies[":id"].$patch({
          param: { id: baby!.id },
          json: {
            name: name.trim(),
            birthDate: new Date(birthDate).toISOString(),
            sex,
          },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["babies"] });
      onOpenChange(false);
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Sheet open={!!baby} onOpenChange={onOpenChange} title={t("Edit baby")}>
      <div className="space-y-5 pb-4">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <ChipGroup
          options={[
            { value: "girl", label: t("Girl") },
            { value: "boy", label: t("Boy") },
          ]}
          value={sex}
          onChange={setSex}
        />
        <input
          type="date"
          value={birthDate}
          max={toLocalDateInput()}
          onChange={(e) => setBirthDate(e.target.value)}
          className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
        />
        <Button
          size="full"
          onClick={() => save.mutate()}
          disabled={save.isPending || name.trim().length === 0 || !birthDate}
        >
          {t("Save")}
        </Button>
        {!sex && (
          <p className="text-xs text-muted">
            {t("Sex is only used for WHO growth percentiles.")}
          </p>
        )}
      </div>
    </Sheet>
  );
}

export function BabiesSection() {
  const babies = useBabies();
  const [editBaby, setEditBaby] = useState<Baby | null>(null);

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
      </Card>
      <BabyEditSheet
        baby={editBaby}
        onOpenChange={(o) => !o && setEditBaby(null)}
      />
    </>
  );
}
