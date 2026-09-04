import { IconX } from "@tabler/icons-react";
import { useState } from "react";
import { InstallSheet } from "@/components/InstallSheet";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  dismissInstallHint,
  promptInstall,
  useInstallHintDismissed,
  useInstallState,
} from "@/lib/install";
import { useAppUpdate } from "@/lib/pwa";

// A one-time nudge toward the home screen, on Home only — deliberately not in
// the shell, so it cannot follow you around the app. Dismissal is permanent
// per device; Settings keeps the instructions reachable afterwards.
export function InstallBanner() {
  const state = useInstallState();
  const dismissed = useInstallHintDismissed();
  const update = useAppUpdate();
  const [sheet, setSheet] = useState(false);

  const offerable =
    state === "prompt-available" ||
    state === "ios-safari" ||
    state === "ios-needs-safari";
  if (!offerable || dismissed) return null;
  // UpdateBanner owns this slot and is the more urgent of the two; stacking
  // both in the same fixed position just renders one on top of the other.
  if (update) return null;

  return (
    <>
      <div className="fixed inset-x-4 bottom-24 z-40 flex items-center gap-2 rounded-xl2 border border-line bg-surface px-4 py-3 shadow-lg">
        <p className="flex-1 text-sm font-semibold text-ink">
          {t("Add Pjokk to your home screen")}
        </p>
        {state === "prompt-available" ? (
          <Button size="sm" onClick={() => void promptInstall()}>
            {t("Install")}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setSheet(true)}>
            {t("Show me")}
          </Button>
        )}
        <button
          type="button"
          aria-label={t("Dismiss")}
          onClick={dismissInstallHint}
          className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2"
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>
      <InstallSheet open={sheet} onOpenChange={setSheet} />
    </>
  );
}
