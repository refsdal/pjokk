import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { signOut, useSession } from "@/lib/auth-client";
import { enrolDevice } from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  isValidPin,
  markEnrolled,
  PIN_MAX,
  PIN_MIN,
  useKiosk,
} from "@/lib/kiosk";
import { resetCache } from "@/lib/query";

// /kiosk/setup (spec 2026-09-10-kiosk-devices §7): the tablet's side of
// enrolment. A family admin adds a device in Settings → Family → Devices and
// gets a one-time code; this screen redeems it and sets the PIN that later
// un-enrols the tablet. The request is the tablet's own, so the device
// cookie lands in whatever browser — or installed home-screen app, whose
// cookies are its own — the kiosk will actually run in. The one place a
// kiosk ever shows the OS keyboard, once.

const CODE_LENGTH = 8;

// The invite-code alphabet has no 0/O/1/I/L; anything else is dropped as it
// is typed rather than rejected after.
function normaliseCode(v: string): string {
  return v
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function enrolError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "INVALID_CODE")
      return t("That code is not valid. Ask for a new one.");
    if (err.status === 429) return t("Too many tries — wait a few minutes");
    return err.message;
  }
  return t("Setting up needs a connection");
}

export function KioskSetupScreen({ initialCode }: { initialCode?: string }) {
  const navigate = useNavigate();
  const kiosk = useKiosk();
  const { data: session } = useSession();
  const [code, setCode] = useState(() => normaliseCode(initialCode ?? ""));
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The code arrived in the URL (the Settings QR): keep it in the field, but
  // not in the address bar or the history.
  useEffect(() => {
    if (initialCode) {
      void navigate({ to: "/kiosk/setup", search: {}, replace: true });
    }
  }, [initialCode, navigate]);

  if (kiosk) return <Navigate to="/kiosk" />;

  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, PIN_MAX);
  const pinProblem =
    pin.length > 0 && !isValidPin(pin)
      ? `${PIN_MIN}–${PIN_MAX} ${t("digits")}`
      : again.length > 0 && again !== pin
        ? t("PINs do not match")
        : null;
  const canStart =
    code.length === CODE_LENGTH && isValidPin(pin) && again === pin && !busy;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await enrolDevice(code, pin);
      // The tablet is the family's now, not a person's: drop any session
      // still in this browser, and whatever it had cached.
      if (session) await signOut().catch(() => {});
      await resetCache();
      markEnrolled(pin.length);
      void navigate({ to: "/kiosk", replace: true });
    } catch (err) {
      setError(enrolError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 pb-safe pt-safe">
      <div className="text-center">
        <img src="/icon.svg" alt="" className="mx-auto h-16 w-16" />
        <h1 className="mt-3 text-2xl font-extrabold text-ink">
          {t("Set up as kiosk")}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {t(
            "Enter the code from Settings → Family → Devices on a family admin's phone, then choose a PIN. The PIN is asked for when leaving kiosk mode.",
          )}
        </p>
      </div>

      <div className="space-y-3">
        <Input
          aria-label={t("Code")}
          placeholder={t("Code")}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="text-center font-mono text-lg tracking-[0.3em] uppercase"
          value={code}
          onChange={(e) => setCode(normaliseCode(e.target.value))}
        />
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder={t("PIN")}
          aria-label={t("PIN")}
          value={pin}
          onChange={(e) => setPin(digitsOnly(e.target.value))}
        />
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder={t("Repeat PIN")}
          aria-label={t("Repeat PIN")}
          value={again}
          onChange={(e) => setAgain(digitsOnly(e.target.value))}
        />
        {(pinProblem ?? error) && (
          <p className="px-1 text-sm text-danger" role="alert">
            {pinProblem ?? error}
          </p>
        )}
        <Button size="full" disabled={!canStart} onClick={() => void start()}>
          {t("Start kiosk")}
        </Button>
      </div>

      <p className="text-center text-xs">
        <Link to="/login" className="font-semibold text-accent">
          {t("Back to sign-in")}
        </Link>
      </p>
    </div>
  );
}
