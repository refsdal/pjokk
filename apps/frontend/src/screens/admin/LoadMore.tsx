import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

// The foot of a paged console list (spec 2026-09-11-admin-user-support §4).
// A button, not infinite scroll: an operator works through a list on
// purpose, and a page that keeps growing under the thumb loses their place.
export function LoadMore({
  hasMore,
  loading,
  onLoad,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  if (!hasMore) return null;
  return (
    <Button size="full" variant="outline" disabled={loading} onClick={onLoad}>
      {loading ? t("Loading…") : t("Load more")}
    </Button>
  );
}
