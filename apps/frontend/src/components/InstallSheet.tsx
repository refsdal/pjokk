import { IconShare2, IconSquarePlus } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { promptInstall, useInstallState } from "@/lib/install";

// How to get Pjokk onto a home screen. The instructions differ by browser
// because the capability does: Chromium hands us a real prompt, iOS Safari
// has a Share-sheet item, and an in-app webview has neither — which is the
// case the original bug report ran into.

function Step({
  n,
  icon,
  children,
}: {
  n: number;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-muted">
        {n}
      </span>
      <span className="flex flex-1 items-center gap-2 text-sm text-ink">
        {children}
        {icon}
      </span>
    </li>
  );
}

export function InstallSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const state = useInstallState();

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Install Pjokk")}>
      <div className="pb-6">
        <p className="pb-2 text-sm text-muted">
          {t("It opens full screen, works offline, and gets its own icon.")}
        </p>

        {state === "prompt-available" && (
          <Button
            size="full"
            onClick={() => {
              void promptInstall();
              onOpenChange(false);
            }}
          >
            {t("Install")}
          </Button>
        )}

        {state === "ios-needs-safari" && (
          <>
            {/* Add to Home Screen genuinely does not exist in a webview or a
                third-party iOS browser, so the first instruction has to be
                "leave this browser" — anything else sends the reader hunting
                for a menu item that is not there. */}
            <p className="pt-2 pb-1 text-sm font-semibold text-ink">
              {t("Open Pjokk in Safari first")}
            </p>
            <p className="text-sm text-muted">
              {t(
                "This browser cannot add apps to the home screen. Open pjokk.no in Safari, then follow the steps below.",
              )}
            </p>
          </>
        )}

        {(state === "ios-safari" || state === "ios-needs-safari") && (
          <ol className="pt-2">
            <Step n={1} icon={<IconShare2 className="h-4 w-4 text-accent" />}>
              {t("Tap the Share button in Safari")}
            </Step>
            <Step
              n={2}
              icon={<IconSquarePlus className="h-4 w-4 text-accent" />}
            >
              {t("Scroll down and tap Add to Home Screen")}
            </Step>
            <Step n={3}>{t("Tap Add — Pjokk lands on your home screen")}</Step>
          </ol>
        )}
      </div>
    </Sheet>
  );
}
