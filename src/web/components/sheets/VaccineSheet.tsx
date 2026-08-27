import {
  IconExternalLink,
  IconFile,
  IconInfoCircle,
  IconPaperclip,
  IconTrash,
} from "@tabler/icons-react";
import { useRef, useState } from "react";
import type { VaccineLog } from "@shared/schemas";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { ChipGroup } from "@/components/Chips";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { API_BASE, ApiError } from "@/lib/api";
import {
  useCreateVaccine,
  useDeleteVaccine,
  useDeleteVaccineDocument,
  usePremium,
  useUpdateVaccine,
  useUploadVaccineDocument,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import {
  infoUrlForName,
  infoUrlForSlot,
  type ProgrammeSlot,
} from "@/lib/vaccine-programme";

// The Norwegian programme tops out at five doses; a stored value beyond
// that (an imported record, a course given abroad) still gets its chip.
const doseOptions = (current: number) => {
  const values = [1, 2, 3, 4, 5];
  if (!values.includes(current)) values.push(current);
  return values.map((n) => ({ value: String(n), label: String(n) }));
};

// ONE sheet for create and edit. When opened from a programme row it comes
// pre-filled with that slot's name and dose; opened blank it is a free-form
// record, because a vaccine given abroad must log just as easily.
export function VaccineSheet({
  open,
  onOpenChange,
  babyId,
  slot = null,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  slot?: ProgrammeSlot | null;
  edit?: VaccineLog | null;
}) {
  const [name, setName] = useState("");
  const [dose, setDose] = useState(1);
  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setName(edit?.name ?? slot?.name ?? "");
    setDose(edit?.doseNumber ?? slot?.dose ?? 1);
    setTime(edit ? new Date(edit.time) : null);
    setNotes(edit?.notes ?? "");
  }
  if (!open && wasOpen) setWasOpen(false);

  // Prefer the slot key (exact), fall back to matching the typed name, so a
  // hand-written "MMR" still finds FHI's page.
  const infoUrl =
    infoUrlForSlot(edit?.scheduleSlot ?? slot?.key ?? null) ??
    infoUrlForName(name);

  const create = useCreateVaccine();
  const update = useUpdateVaccine();
  const remove = useDeleteVaccine();

  const save = () => {
    const trimmed = notes.trim();
    const when = (time ?? new Date()).toISOString();
    if (edit) {
      update.mutate(
        {
          id: edit.id,
          patch: {
            time: when,
            name: name.trim(),
            doseNumber: dose,
            notes: trimmed || null,
          },
        },
        { onError: (err) => toast(err.message, "error") },
      );
    } else {
      create.mutate(
        {
          babyId,
          time: when,
          name: name.trim(),
          doseNumber: dose,
          ...(slot ? { scheduleSlot: slot.key } : {}),
          ...(trimmed ? { notes: trimmed } : {}),
        },
        { onError: (err) => toast(err.message, "error") },
      );
    }
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit vaccine") : t("Log vaccine")}
    >
      <div className="space-y-5 pb-4">
        <Input
          placeholder={t("Vaccine")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Dose")}
          </p>
          <ChipGroup
            options={doseOptions(dose)}
            value={String(dose)}
            onChange={(v) => setDose(Number(v))}
          />
        </div>

        {/* We say nothing about any vaccine ourselves — this is a pointer to
            the government's own page and nothing more. Absent (rather than
            guessed) for anything outside the programme. */}
        {infoUrl && (
          <a
            href={infoUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-11 items-center gap-2 rounded-xl2 border border-line bg-surface px-3 py-2 text-sm font-semibold text-accent active:bg-surface-2"
          >
            <IconInfoCircle className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">
              {t("About this vaccine at FHI")}
            </span>
            <IconExternalLink className="h-4 w-4 shrink-0 text-muted" />
          </a>
        )}

        <TimeField key={`v${instance}`} value={time} onChange={setTime} />

        <Input
          placeholder={t("Note (optional)")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {/* Attachments need an id, so they only exist in edit mode. */}
        {edit && <Documents entry={edit} />}

        <Button size="full" onClick={save} disabled={name.trim().length === 0}>
          {t("Save")}
        </Button>

        {edit && (
          <>
            <p className="text-xs text-muted">
              {t("Deleting a vaccine also deletes its documents.")}
            </p>
            <DeleteButton
              onDelete={() =>
                remove.mutate(edit.id, {
                  onSuccess: () => onOpenChange(false),
                  onError: (err) => toast(err.message, "error"),
                })
              }
            />
          </>
        )}
      </div>
    </Sheet>
  );
}

function Documents({ entry }: { entry: VaccineLog }) {
  const premium = usePremium();
  const upload = useUploadVaccineDocument();
  const removeDoc = useDeleteVaccineDocument();
  const fileInput = useRef<HTMLInputElement>(null);

  const pick = () => {
    if (!premium) {
      toast(t("Premium feature — upgrade in Settings"));
      return;
    }
    fileInput.current?.click();
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        {t("Documents")}
      </p>

      {entry.documents.map((doc) => (
        <div
          key={doc.id}
          className="flex items-center gap-2 rounded-xl2 border border-line bg-surface px-3 py-2"
        >
          <IconFile className="h-5 w-5 shrink-0 text-muted" />
          <a
            href={`${API_BASE}${doc.url}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-sm font-semibold text-accent"
          >
            {doc.filename}
          </a>
          <button
            type="button"
            aria-label={t("Delete")}
            onClick={() =>
              removeDoc.mutate(doc.id, {
                onError: (err) => toast(err.message, "error"),
              })
            }
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
          >
            <IconTrash className="h-4 w-4" />
          </button>
        </div>
      ))}

      <input
        ref={fileInput}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          upload.mutate(
            { id: entry.id, file },
            {
              onError: (err) => {
                if (err instanceof ApiError && err.code === "PLAN_REQUIRED") {
                  toast(t("Premium feature — upgrade in Settings"), "error");
                  return;
                }
                toast(err.message, "error");
              },
            },
          );
        }}
      />

      <Button
        size="full"
        variant="outline"
        onClick={pick}
        disabled={upload.isPending}
      >
        <IconPaperclip className="mr-1.5 h-4 w-4" />
        {upload.isPending ? t("Uploading…") : t("Attach document")}
        {!premium && ` · ${t("Premium")}`}
      </Button>
    </div>
  );
}
