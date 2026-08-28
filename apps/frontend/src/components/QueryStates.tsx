import { IconCloudOff, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

// Shared loading/error states so no screen ever renders a blank void or a
// convincingly-empty list when a query fails.

export function LoadingState() {
  return (
    <output
      className="flex min-h-40 items-center justify-center py-10"
      aria-live="polite"
    >
      <IconLoader2 className="h-6 w-6 animate-spin text-muted" />
      <span className="sr-only">{t("Loading…")}</span>
    </output>
  );
}

export function ErrorState({
  onRetry,
  message,
}: {
  onRetry: () => void;
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <IconCloudOff className="h-8 w-8 text-muted" />
      <p className="text-sm text-muted">{message ?? t("Couldn't load")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("Try again")}
      </Button>
    </div>
  );
}
