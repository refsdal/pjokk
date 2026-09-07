import { useEffect, useState } from "react";
import { ReminderSheet } from "@/components/sheets/ReminderSheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBabies } from "@/lib/data";
import { useDeleteReminder, useReminders } from "@/lib/data/reminders";
import { t } from "@/lib/i18n";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupported,
  sendTestPush,
} from "@/lib/push";
import { describeReminder } from "@/lib/reminder-ui";
import { toast } from "@/lib/toast";

export function NotificationsSection() {
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then((sub) => setSubscribed(!!sub));
  }, [supported]);

  // Reminders (issue #45) are the caller's own list, per family, and are
  // shown whether or not THIS device has push: a phone can configure the
  // nags a tablet receives.
  const reminders = useReminders();
  const babies = useBabies();
  const deleteReminder = useDeleteReminder();
  const babyName = (id: string | null) =>
    id ? (babies.data?.find((b) => b.id === id)?.name ?? null) : null;

  const togglePush = async () => {
    setBusy(true);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
      } else {
        await enablePush();
        setSubscribed(true);
        toast(t("Notifications enabled on this device"));
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Push failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const remindersBlock = (
    <div className="space-y-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">
        {t("Reminders")}
      </p>
      {(reminders.data ?? []).length === 0 && (
        <p className="text-sm text-muted">
          {t(
            "No reminders yet. Add one for a feed gap, a medicine or a fixed time.",
          )}
        </p>
      )}
      {(reminders.data ?? []).map((r) => {
        const { title, detail } = describeReminder(r, babyName(r.babyId));
        return (
          <div key={r.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{title}</p>
              {detail && (
                <p className="truncate text-xs text-muted">{detail}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() =>
                deleteReminder.mutate(r.id, {
                  onError: (err) => toast(err.message, "error"),
                })
              }
            >
              {t("Delete")}
            </Button>
          </div>
        );
      })}
      <Button variant="secondary" size="full" onClick={() => setAdding(true)}>
        {t("Add reminder")}
      </Button>
      <ReminderSheet
        open={adding}
        onOpenChange={setAdding}
        babies={babies.data ?? []}
      />
    </div>
  );

  if (!supported) {
    return (
      <Card className="space-y-4">
        <p className="text-sm text-muted">
          {t(
            "Push is not available in this browser. On iPhone, add Pjokk to the Home Screen first.",
          )}
        </p>
        {remindersBlock}
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <Button
        size="full"
        variant={subscribed ? "outline" : "primary"}
        disabled={busy || subscribed === null}
        onClick={() => void togglePush()}
      >
        {subscribed ? t("Disable on this device") : t("Enable notifications")}
      </Button>

      {remindersBlock}

      {subscribed && (
        <Button
          size="full"
          variant="ghost"
          onClick={() =>
            void sendTestPush().then((sent) =>
              toast(
                sent > 0
                  ? t("Test sent — check your notifications")
                  : t("No delivery — try re-enabling push"),
              ),
            )
          }
        >
          {t("Send test notification")}
        </Button>
      )}
    </Card>
  );
}
