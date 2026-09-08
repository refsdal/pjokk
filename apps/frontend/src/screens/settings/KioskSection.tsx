import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { enableKiosk, isValidPin, PIN_MAX, PIN_MIN } from "@/lib/kiosk";
import { SectionTitle } from "./lib";

// Settings → Preferences → Kiosk mode (spec §8): the switch and its PIN.
// Entries are logged as the signed-in user until the caretaker selector
// (spec 3) ships, and the copy says so.
export function KioskSection() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const digitsOnly = (v: string) => v.replace(/\D/g, "").slice(0, PIN_MAX);
  const error =
    pin.length > 0 && !isValidPin(pin)
      ? `${PIN_MIN}–${PIN_MAX} ${t("digits")}`
      : again.length > 0 && again !== pin
        ? t("PINs do not match")
        : null;
  const canStart = isValidPin(pin) && again === pin && !busy;
  const start = async () => {
    setBusy(true);
    try {
      await enableKiosk(pin);
      setOpen(false);
      void navigate({ to: "/kiosk" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle>{t("Kiosk mode")}</SectionTitle>
      <Card className="space-y-3">
        <p className="text-sm text-muted">
          {t(
            "Turns this device into the family's care station: a big clock, the last feed, diaper and sleep with one-tap logging, and nothing else. Entries are logged as you. Leaving asks for a PIN.",
          )}
        </p>
        <Button
          size="full"
          variant="outline"
          onClick={() => {
            setPin("");
            setAgain("");
            setOpen(true);
          }}
        >
          {t("Turn on kiosk mode")}
        </Button>
      </Card>
      <Sheet open={open} onOpenChange={setOpen} title={t("Kiosk mode")}>
        <div className="space-y-4 pb-4">
          <p className="text-sm text-muted">
            {t("Choose a PIN for leaving kiosk mode on this device.")}
          </p>
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
          {error && <p className="px-1 text-sm text-danger">{error}</p>}
          <Button size="full" disabled={!canStart} onClick={() => void start()}>
            {t("Start kiosk")}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
