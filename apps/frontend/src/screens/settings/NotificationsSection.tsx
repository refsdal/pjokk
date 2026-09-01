import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupported,
  sendTestPush,
} from "@/lib/push";
import { toast } from "@/lib/toast";

export function NotificationsSection() {
  const queryClient = useQueryClient();
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then((sub) => setSubscribed(!!sub));
  }, [supported]);

  const prefs = useQuery({
    queryKey: ["pushPrefs"],
    queryFn: async () =>
      unwrap<{ feedReminderHours: 0 | 3 | 4 | 6 }>(
        client.GET("/api/push/prefs"),
      ),
  });

  const savePrefs = useMutation({
    mutationFn: async (feedReminderHours: 0 | 3 | 4 | 6) =>
      unwrap(client.PUT("/api/push/prefs", { body: { feedReminderHours } })),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["pushPrefs"] }),
    onError: (err) => toast(err.message, "error"),
  });

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

  if (!supported) {
    return (
      <Card>
        <p className="text-sm text-muted">
          {t(
            "Push is not available in this browser. On iPhone, add Pjokk to the Home Screen first.",
          )}
        </p>
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

      <div>
        <p className="pb-2 text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Remind me when no feed for")}
        </p>
        <ChipGroup
          options={[
            { value: "0", label: t("Off") },
            { value: "3", label: "3 h" },
            { value: "4", label: "4 h" },
            { value: "6", label: "6 h" },
          ]}
          value={String(prefs.data?.feedReminderHours ?? 0) as "0"}
          onChange={(v) => savePrefs.mutate(Number(v) as 0 | 3 | 4 | 6)}
        />
      </div>

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
