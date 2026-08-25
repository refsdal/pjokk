import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Baby } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { toLocalDateInput } from "@/lib/time";
import { toast } from "@/lib/toast";

// ONE sheet for adding and editing a baby. Deleting (admin-only, cascades
// every log) lives in edit mode behind the two-tap DeleteButton.
export function BabySheet({
  open,
  onOpenChange,
  baby = null,
  canDelete = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baby?: Baby | null;
  canDelete?: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [sex, setSex] = useState<"girl" | "boy" | null>(null);
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setName(baby?.name ?? "");
    setBirthDate(baby ? toLocalDateInput(new Date(baby.birthDate)) : "");
    setSex(baby?.sex ?? null);
  }
  if (!open && wasOpen) setWasOpen(false);

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ["babies"] });
    onOpenChange(false);
  };

  const save = useMutation({
    mutationFn: async () => {
      const json = {
        name: name.trim(),
        birthDate: new Date(birthDate).toISOString(),
        sex,
      };
      return baby
        ? unwrap(
            await api.babies[":id"].$patch({ param: { id: baby.id }, json }),
          )
        : unwrap(
            await api.babies.$post({
              json: { ...json, sex: sex ?? undefined },
            }),
          );
    },
    onSuccess: done,
    onError: (err) => toast(err.message, "error"),
  });

  const remove = useMutation({
    mutationFn: async () =>
      unwrap(await api.babies[":id"].$delete({ param: { id: baby!.id } })),
    onSuccess: () => {
      toast(t("Baby removed"));
      done();
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={baby ? t("Edit baby") : t("Add baby")}
    >
      <div className="space-y-5 pb-4">
        <Input
          placeholder={t("Baby's name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
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
          aria-label={t("Birth date")}
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
        {baby && canDelete && (
          <>
            <p className="text-xs text-muted">
              {t("Removing a baby permanently deletes every log for them.")}
            </p>
            <DeleteButton onDelete={() => remove.mutate()} />
          </>
        )}
      </div>
    </Sheet>
  );
}
