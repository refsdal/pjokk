import { IconHandStop } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { HelpRequest } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import {
  useAcknowledgeHelpRequest,
  useDeleteHelpRequest,
  useMe,
} from "@/lib/data";
import { helpCardView } from "@/lib/help-ui";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

// A call for help is the one thing on Home that must be seen before
// anything else, so while open it breaks the "tints on icons only" rule
// deliberately: a 2 px danger border, a radiating ring and a waving hand
// (styles.css help-ping / help-wave). It goes calm the moment someone
// answers. What each viewer may do is decided in lib/help-ui.ts.
export function HelpCard({ request }: { request: HelpRequest }) {
  const me = useMe();
  const acknowledge = useAcknowledgeHelpRequest();
  const dismiss = useDeleteHelpRequest();
  // Re-render each minute so the relative time stays honest.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!me.data) return null;
  const view = helpCardView(request, {
    userId: me.data.userId,
    isAdmin: me.data.memberRole === "admin" || me.data.memberRole === "owner",
  });
  const open = view.state === "open";
  const from = view.from || t("Someone");
  const headline = open
    ? view.viewerIsTarget
      ? `${from} ${t("needs a hand")}`
      : `${from} ${t("needs a hand from")} ${view.to || t("someone")}`
    : `${view.ackBy || t("Someone")} ${t("is on the way")}`;
  const busy = acknowledge.isPending || dismiss.isPending;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl2 border-2 bg-surface p-4 transition-colors duration-300",
        open ? "border-danger animate-help-ping" : "border-line",
      )}
    >
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 transition-colors duration-300",
          open ? "text-danger" : "text-ok",
        )}
      >
        <IconHandStop className={cn("h-5 w-5", open && "animate-help-wave")} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {open ? t("Help requested") : t("On the way")}
        </p>
        <p className="line-clamp-2 break-words text-base font-bold text-ink">
          {headline}
        </p>
        <p className="truncate text-xs text-muted">
          {formatRelative(view.at)}
          {request.message ? ` · ${request.message}` : ""}
        </p>
      </div>
      {view.action === "acknowledge" && (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => acknowledge.mutate({ id: request.id })}
          disabled={busy}
        >
          {t("On my way")}
        </Button>
      )}
      {view.action === "cancel" && (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => dismiss.mutate({ id: request.id })}
          disabled={busy}
        >
          {t("Never mind")}
        </Button>
      )}
      {view.action === "done" && (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => dismiss.mutate({ id: request.id })}
          disabled={busy}
        >
          {t("Done")}
        </Button>
      )}
    </div>
  );
}
