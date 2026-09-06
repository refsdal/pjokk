import { useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateHelpRequest, useMe, useMembers } from "@/lib/data";
import {
  HELP_MESSAGE_MAX,
  HELP_PRESETS,
  pickDefaultMember,
  readLastHelpMember,
  writeLastHelpMember,
} from "@/lib/help-ui";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Ask one other member for a hand. Two taps in the common case: the
// last-asked member is prefilled, so open → Send. The message is optional
// and the presets fill it without the keyboard (CLAUDE.md §5); the text
// field is there for the rest. Reachable from the More sheet.
export function HelpSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const me = useMe();
  const members = useMembers();
  const create = useCreateHelpRequest();
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setPicked(null);
    setMessage("");
  }
  if (!open && wasOpen) setWasOpen(false);

  const familyId = me.data?.familyId ?? "";
  const others = (members.data ?? []).filter(
    (m) => m.userId !== me.data?.userId,
  );
  // Derived at render rather than on open: the members query may still be
  // loading when the sheet opens, and the prefill must appear when it lands.
  const selected =
    picked && others.some((m) => m.memberId === picked)
      ? picked
      : pickDefaultMember(others, readLastHelpMember(familyId));
  const target = others.find((m) => m.memberId === selected) ?? null;
  const presetValue = HELP_PRESETS.find((p) => t(p) === message) ?? null;

  const send = () => {
    if (!selected || !target) return;
    const trimmed = message.trim().slice(0, HELP_MESSAGE_MAX);
    create.mutate(
      { memberId: selected, ...(trimmed ? { message: trimmed } : {}) },
      {
        onSuccess: (req) => {
          writeLastHelpMember(familyId, selected);
          const name = target.name || target.email;
          toast(
            req.delivered > 0
              ? `${t("Sent to")} ${name}`
              : `${name} ${t("hasn't turned on notifications")}`,
          );
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Ask for help")}>
      <div className="space-y-5 pb-4">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Who?")}
        </p>
        {members.isSuccess && others.length === 0 ? (
          <p className="text-sm text-muted">
            {t("No one else in the family yet")}
          </p>
        ) : (
          <ChipGroup
            options={others.map((m) => ({
              value: m.memberId,
              label: (
                <span className={cn(!m.hasPush && "opacity-60")}>
                  {m.name || m.email}
                  {!m.hasPush && (
                    <span className="block text-[10px] font-normal leading-tight">
                      {t("No notifications")}
                    </span>
                  )}
                </span>
              ),
            }))}
            value={selected}
            onChange={setPicked}
          />
        )}

        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Message")}
        </p>
        <ChipGroup
          options={HELP_PRESETS.map((p) => ({ value: p, label: t(p) }))}
          value={presetValue}
          onChange={(p) => setMessage(t(p))}
        />
        <Input
          placeholder={t("Message (optional)")}
          value={message}
          maxLength={HELP_MESSAGE_MAX}
          onChange={(e) => setMessage(e.target.value)}
        />

        <Button
          size="full"
          onClick={send}
          disabled={!selected || create.isPending}
        >
          {t("Send")}
        </Button>
      </div>
    </Sheet>
  );
}
