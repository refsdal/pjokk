import { formatMegabytes, usePhotoUsage } from "@/lib/data/photos";
import { t } from "@/lib/i18n";

// "Photos: 12 MB of 500 MB" — the family's milestone photos against the
// PHOTO_QUOTA_MB the instance was started with (issue #48).
export function PhotoUsageLine() {
  const usage = usePhotoUsage();
  if (!usage.data) return null;
  const { bytes, quotaBytes } = usage.data;
  return (
    <p className="text-sm text-muted">
      {t("Photos")}: {formatMegabytes(bytes)}
      {quotaBytes > 0
        ? ` ${t("of")} ${formatMegabytes(quotaBytes)}`
        : ` · ${t("no limit")}`}
    </p>
  );
}
