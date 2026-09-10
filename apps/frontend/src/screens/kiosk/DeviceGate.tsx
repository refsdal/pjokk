import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/QueryStates";
import { ApiError } from "@/lib/api";
import { useDeviceSelf } from "@/lib/data";
import { t } from "@/lib/i18n";
import { clearKioskFlags, isLeavingKiosk, leaveKiosk } from "@/lib/kiosk";
import { deviceGateVerdict } from "@/lib/kiosk-ui";
import { onDeviceRevoked } from "@/lib/query";
import { toast } from "@/lib/toast";

// The kiosk's own gate (spec 2026-09-10-kiosk-devices §6), in place of the
// app shell's AuthGate: an enrolled tablet holds no person's session, so it
// asks GET /api/device rather than Limen and /api/me. The answer is
// persisted, so a kiosk that reloads with no signal still starts.
export function DeviceGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const device = useDeviceSelf();
  const [revoked, setRevoked] = useState(false);
  useEffect(() => onDeviceRevoked(() => setRevoked(true)), []);

  const verdict = deviceGateVerdict({
    code: device.error instanceof ApiError ? (device.error.code ?? null) : null,
    hadDevice: device.data !== undefined,
    revoked,
    leaving: isLeavingKiosk(),
  });

  // Revoked by an admin, or un-enrolled elsewhere: forget everything and
  // land on sign-in with a word about why. A full load, so nothing of the
  // family survives in memory either. leaveKiosk marks the page as leaving,
  // so this runs once.
  useEffect(() => {
    if (verdict !== "revoked") return;
    void leaveKiosk().then(() =>
      window.location.assign("/login?notice=revoked"),
    );
  }, [verdict]);

  // A tablet made a kiosk the old way (spec 2's local PIN): the flag is set
  // but there has never been a device behind it. Drop the old state and
  // carry on in the normal app. The flags are cleared BEFORE navigating, in
  // this effect, so the shell cannot see them and send the tablet back.
  const handled = useRef(false);
  useEffect(() => {
    if (verdict !== "not-a-device" || handled.current) return;
    handled.current = true;
    clearKioskFlags();
    toast(t("Kiosk mode now needs a device — Settings → Family → Devices"));
    void navigate({ to: "/home", replace: true });
  }, [verdict, navigate]);

  if (verdict !== "ok" || device.isPending) {
    return <div className="min-h-dvh bg-bg" />;
  }
  if (!device.data) {
    return (
      <div className="flex min-h-dvh flex-col justify-center bg-bg">
        <ErrorState onRetry={() => void device.refetch()} />
      </div>
    );
  }
  return <>{children}</>;
}
