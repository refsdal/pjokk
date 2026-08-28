import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiKey, ApiKeyCreated } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";

export function ApiKeysSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [expiry, setExpiry] = useState<"never" | "90" | "365">("365");
  const [freshKey, setFreshKey] = useState<ApiKeyCreated | null>(null);

  const keys = useQuery({
    queryKey: ["apiKeys"],
    queryFn: async () => unwrap<ApiKey[]>(await api.keys.$get()),
  });

  const createKey = useMutation({
    mutationFn: async () =>
      unwrap<ApiKeyCreated>(
        await api.keys.$post({
          json: {
            name: name.trim(),
            readOnly,
            ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
          },
        }),
      ),
    onSuccess: (created) => {
      setFreshKey(created);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  const revokeKey = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.keys[":id"].$delete({ param: { id } })),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] }),
    // A failed revoke must never look like success — the key stays live.
    onError: (err) => toast(err.message, "error"),
  });

  const activeKeys = (keys.data ?? []).filter((k) => !k.revokedAt);

  return (
    <Card className="space-y-4">
      <p className="text-sm text-muted">
        {t(
          "Bearer keys for Home Assistant, Grafana & friends. Keys can read and log, but never manage the family.",
        )}
      </p>

      {freshKey && (
        <div className="space-y-2 rounded-xl2 bg-accent-soft p-3">
          <p className="text-xs font-semibold text-accent">
            {t("Copy this key now — it will never be shown again")}
          </p>
          <p className="font-mono text-xs break-all text-ink">{freshKey.key}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(freshKey.key)
                .then(() => toast(t("Key copied")))
            }
          >
            {t("Copy key")}
          </Button>
        </div>
      )}

      {activeKeys.map((k) => (
        <div key={k.id} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">
              {k.name}
              {k.readOnly && (
                <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted uppercase">
                  {t("read-only")}
                </span>
              )}
            </p>
            <p className="truncate font-mono text-xs text-muted">
              {k.prefix}…{" · "}
              {k.lastUsedAt
                ? `${t("used")} ${formatRelative(new Date(k.lastUsedAt))}`
                : t("never used")}
              {k.expiresAt
                ? ` · ${t("expires")} ${new Date(k.expiresAt).toLocaleDateString("nb-NO")}`
                : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => revokeKey.mutate(k.id)}
          >
            {t("Revoke")}
          </Button>
        </div>
      ))}

      <div className="space-y-3">
        <Input
          placeholder={t("Key name (e.g. “Home Assistant”)")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ChipGroup
          options={[
            { value: "rw", label: t("Read + write") },
            { value: "ro", label: t("Read-only") },
          ]}
          value={readOnly ? "ro" : "rw"}
          onChange={(v) => setReadOnly(v === "ro")}
        />
        <ChipGroup
          options={[
            { value: "90", label: t("90 days") },
            { value: "365", label: t("1 year") },
            { value: "never", label: t("Never expires") },
          ]}
          value={expiry}
          onChange={setExpiry}
        />
        <Button
          size="full"
          variant="secondary"
          disabled={createKey.isPending || name.trim().length === 0}
          onClick={() => createKey.mutate()}
        >
          {t("Create")}
        </Button>
      </div>
    </Card>
  );
}
