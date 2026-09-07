import { IconCheck } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { authClient, signOut } from "@/lib/auth-client";
import { useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { resetCache } from "@/lib/query";
import { clearSelectedBaby } from "@/lib/selected-baby";
import { toast } from "@/lib/toast";

// Opens from the avatar chip on Home (CLAUDE.md IA: "caretaker chip (avatar
// → family switcher)"): the person, their families, and the way out.
export function AccountSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Limen's own list route (allowlisted server-side). Never persisted.
  const families = useQuery({
    queryKey: ["my-families"],
    enabled: open,
    queryFn: async () => (await authClient.organization.list()).items,
  });

  const switchTo = async (id: string) => {
    if (id === me.data?.familyId) {
      onOpenChange(false);
      return;
    }
    // Queued offline writes carry THIS family's baby ids; replayed after a
    // switch the server would reject them under tenancy and the entry
    // would be lost. Refuse rather than lose a log.
    const paused = qc
      .getMutationCache()
      .getAll()
      .some((m) => m.state.isPaused);
    if (paused) {
      toast(t("Finish syncing before switching family"), "error");
      return;
    }
    setBusy(true);
    // Two phases, deliberately not one try/catch: the server-side switch is
    // the part that can genuinely fail and must be reported as such. Once it
    // has succeeded, the local cleanup (forgetting the selected baby,
    // resetting the cache) can still throw — a blocked/quota-limited
    // IndexedDB in private browsing, say — but that is never a failed
    // switch, just a cache that a full reload below re-derives anyway.
    try {
      await authClient.organization.switch({ id });
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t("Could not switch family"),
        "error",
      );
      setBusy(false);
      return;
    }
    clearSelectedBaby();
    try {
      await resetCache();
    } catch {
      // The persister can refuse (private browsing, quota); the full
      // document load below re-derives everything from the server and the
      // family fence records the new family.
    }
    onOpenChange(false);
    window.location.assign("/home");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Account")}>
      <div className="space-y-4 pb-4">
        <Link
          to="/profile"
          onClick={() => onOpenChange(false)}
          className="flex min-h-14 items-center gap-3 rounded-xl2 border border-line px-4 py-2 active:bg-surface-2"
        >
          <Avatar
            src={me.data?.avatarUrl}
            name={me.data?.displayName ?? "?"}
            size={11}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-ink">
              {me.data?.displayName}
            </span>
            <span className="block truncate text-xs text-muted">
              {me.data?.email}
            </span>
          </span>
          <span className="text-sm font-semibold text-accent">
            {t("Your profile")}
          </span>
        </Link>

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Families")}
          </p>
          <div className="divide-y divide-line rounded-xl2 border border-line">
            {(families.data ?? []).map((f) => {
              const active = f.id === me.data?.familyId;
              return (
                <button
                  key={f.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void switchTo(f.id)}
                  className="flex min-h-12 w-full items-center gap-3 px-4 text-left active:bg-surface-2"
                >
                  <span className="flex-1 truncate font-semibold text-ink">
                    {f.name}
                  </span>
                  {active && <IconCheck className="h-5 w-5 text-accent" />}
                </button>
              );
            })}
            {families.isPending && (
              <p className="px-4 py-3 text-sm text-muted">{t("Loading…")}</p>
            )}
          </div>
        </div>

        <Button
          size="full"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void signOut().then(() => window.location.assign("/login"))
          }
        >
          {t("Sign out")}
        </Button>
      </div>
    </Sheet>
  );
}
