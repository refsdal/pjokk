import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { useAppUpdate } from "@/lib/pwa";

export function UpdateBanner() {
  const update = useAppUpdate();
  if (!update) return null;
  return (
    <div className="fixed inset-x-4 bottom-24 z-50 flex items-center justify-between gap-3 rounded-xl2 bg-ink px-4 py-3 text-bg shadow-lg">
      <p className="text-sm font-semibold">{t("A new version is ready")}</p>
      <Button size="sm" variant="secondary" onClick={update}>
        {t("Update")}
      </Button>
    </div>
  );
}
