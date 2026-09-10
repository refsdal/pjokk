import { IconDeviceTablet } from "@tabler/icons-react";
import { useState } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { InviteQR } from "@/components/InviteQR";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { signOut } from "@/lib/auth-client";
import {
  type Device,
  type DeviceCode,
  useCreateDevice,
  useDevices,
  useRenewDeviceCode,
  useRevokeDevice,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { resetCache } from "@/lib/query";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

// Settings → Family → Devices (spec 2026-09-10-kiosk-devices §7): the
// family's kiosk tablets. Admins only — adding and revoking a device is
// family administration, like invites and API keys. A device is added here,
// set up on the tablet with the one-time code, and revoked here (or by the
// PIN on the tablet itself).

function statusLine(d: Device, now: Date): string {
  if (d.status === "active") {
    const setUp = new Date(d.enrolledAt ?? d.createdAt).toLocaleDateString(
      "nb-NO",
      { day: "numeric", month: "short" },
    );
    return d.lastUsedAt
      ? `${t("Set up")} ${setUp} · ${t("Last used")} ${formatRelative(new Date(d.lastUsedAt), now)}`
      : `${t("Set up")} ${setUp}`;
  }
  const left = d.codeExpiresAt
    ? Math.ceil((new Date(d.codeExpiresAt).getTime() - now.getTime()) / 60_000)
    : 0;
  return left > 0
    ? `${t("Waiting for set-up")} · ${t("code expires in")} ${left} ${t("min")}`
    : t("Code expired — make a new one");
}

// The one place a set-up code is ever shown. The QR opens /kiosk/setup with
// the code filled in (Android tablets share the browser's cookies with the
// installed app); an iPad types it on its own set-up screen instead.
function CodeCard({ code }: { code: DeviceCode }) {
  return (
    <div className="space-y-3">
      <InviteQR url={code.setupUrl} />
      <p
        className="text-center font-mono text-3xl font-bold tracking-[0.3em] text-ink"
        data-testid="device-code"
      >
        {code.code}
      </p>
      <p className="text-center text-sm text-muted">
        {t(
          "On the tablet, open Pjokk and tap Set up as kiosk on the sign-in screen. The code works once, for 15 minutes.",
        )}
      </p>
    </div>
  );
}

export function DevicesSection() {
  const devices = useDevices(true);
  const create = useCreateDevice();
  const renew = useRenewDeviceCode();
  const revoke = useRevokeDevice();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [shown, setShown] = useState<DeviceCode | null>(null);
  const [manage, setManage] = useState<Device | null>(null);
  const now = new Date();
  const list = devices.data ?? [];

  const failed = (err: Error) =>
    toast(
      err instanceof ApiError && err.code === "DEVICE_LIMIT"
        ? t("A family can have at most 10 devices")
        : err.message,
      "error",
    );

  const openAdd = () => {
    setName(t("Kiosk"));
    setShown(null);
    setAdding(true);
  };

  // The spare iPad a parent is already signed in on: this browser stops
  // being theirs and continues on the set-up screen with the code in hand.
  // Relative, not setupUrl: the tablet stays on the origin it is already on.
  const useThisDevice = async (code: DeviceCode) => {
    await signOut().catch(() => {});
    await resetCache();
    window.location.assign(
      `/kiosk/setup?code=${encodeURIComponent(code.code)}`,
    );
  };

  return (
    <>
      <SectionTitle>{t("Devices")}</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {list.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => {
              setShown(null);
              setManage(d);
            }}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
          >
            <IconDeviceTablet className="h-6 w-6 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">{d.name}</p>
              <p className="truncate text-xs text-muted">
                {statusLine(d, now)}
              </p>
            </div>
          </button>
        ))}
        <div className="space-y-3 p-4">
          {list.length === 0 && (
            <p className="text-sm text-muted">
              {t(
                "A tablet on the changing table can be the family's kiosk: a big clock, the last feed, diaper and sleep, and one-tap logging by whoever is there.",
              )}
            </p>
          )}
          <Button size="full" variant="outline" onClick={openAdd}>
            {t("Add device")}
          </Button>
        </div>
      </Card>

      <Sheet open={adding} onOpenChange={setAdding} title={t("Add device")}>
        <div className="space-y-4 pb-4">
          {shown ? (
            <>
              <CodeCard code={shown} />
              <Button
                size="full"
                variant="outline"
                onClick={() => void useThisDevice(shown)}
              >
                {t("Use this device")}
              </Button>
              <Button size="full" onClick={() => setAdding(false)}>
                {t("Done")}
              </Button>
            </>
          ) : (
            <>
              <Input
                aria-label={t("Device name")}
                placeholder={t("Device name")}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                size="full"
                disabled={!name.trim() || create.isPending}
                onClick={() =>
                  create.mutate(name.trim(), {
                    onSuccess: setShown,
                    onError: failed,
                  })
                }
              >
                {t("Create device")}
              </Button>
            </>
          )}
        </div>
      </Sheet>

      <Sheet
        open={!!manage}
        onOpenChange={(open) => {
          if (!open) setManage(null);
        }}
        title={manage?.name ?? t("Devices")}
      >
        {manage && (
          <div className="space-y-4 pb-4">
            <p className="text-sm text-muted">{statusLine(manage, now)}</p>
            {shown ? (
              <CodeCard code={shown} />
            ) : (
              manage.status === "pending" && (
                <Button
                  size="full"
                  variant="outline"
                  disabled={renew.isPending}
                  onClick={() =>
                    renew.mutate(manage.id, {
                      onSuccess: setShown,
                      onError: failed,
                    })
                  }
                >
                  {t("New code")}
                </Button>
              )
            )}
            <DeleteButton
              label={t("Revoke")}
              onDelete={() =>
                revoke.mutate(manage.id, {
                  onSuccess: () => {
                    setManage(null);
                    toast(t("Device revoked"));
                  },
                  onError: failed,
                })
              }
            />
          </div>
        )}
      </Sheet>
    </>
  );
}
