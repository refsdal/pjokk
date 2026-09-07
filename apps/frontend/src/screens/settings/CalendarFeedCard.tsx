import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconCalendarPlus, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import type { ApiKeyCreated } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_BASE, client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

// Settings → Data → Calendar subscription (issue #52): an .ics feed URL a
// phone or Google Calendar can subscribe to. The URL carries a read-only
// API key — a subscription cannot send a header — so the key is minted
// here, shown once like every key, and revocable under API keys.
export function CalendarFeedCard() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const mint = useMutation({
    mutationFn: async () =>
      unwrap<ApiKeyCreated>(
        client.POST("/api/keys", {
          body: { name: "Calendar subscription", readOnly: true },
        }),
      ),
    onSuccess: (created) => {
      const origin =
        API_BASE ||
        (typeof window === "undefined" ? "" : window.location.origin);
      setUrl(`${origin}/api/calendar.ics?key=${created.key}`);
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Card className="space-y-3">
      <p className="text-sm text-muted">
        {t(
          "See the family's events in your phone's calendar or Google Calendar. Repeating events come along as rules.",
        )}
      </p>
      {url ? (
        <>
          <p className="rounded-xl2 bg-surface-2 px-3 py-2 font-mono text-xs break-all text-ink">
            {url}
          </p>
          <p className="text-xs text-muted">
            {t(
              "This link is a password: anyone who has it can read the family's calendar. It is shown once — copy it now, and revoke it under API keys if it leaks.",
            )}
          </p>
          <Button
            size="full"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => toast(t("Link copied")))
                .catch(() => toast(t("Could not copy"), "error"))
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <IconCopy className="h-4 w-4" />
              {t("Copy link")}
            </span>
          </Button>
        </>
      ) : (
        <Button
          size="full"
          variant="outline"
          onClick={() => mint.mutate()}
          disabled={mint.isPending}
        >
          <span className="inline-flex items-center gap-1.5">
            <IconCalendarPlus className="h-4 w-4" />
            {t("Create calendar link")}
          </span>
        </Button>
      )}
    </Card>
  );
}
