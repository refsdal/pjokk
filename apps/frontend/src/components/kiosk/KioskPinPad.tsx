import { IconBackspace, IconLock } from "@tabler/icons-react";
import { useEffect, useReducer } from "react";
import { t } from "@/lib/i18n";
import type { UnenrolResult } from "@/lib/data";
import {
  PIN_MAX_WRONG,
  type PinPadEvent,
  type PinPadState,
  pinPadReducer,
} from "@/lib/kiosk-ui";
import { cn, focusRing } from "@/lib/utils";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// Leaving kiosk (spec §6): dots, a 3×4 keypad, Cancel. Submits on the
// stored PIN's length to `verify` — the server, which un-enrols the device on
// the right PIN (spec 2026-09-10-kiosk-devices §6). Three wrong in a row hand
// a lockout to the screen; the server keeps its own count as well.
export function KioskPinPad({
  length,
  verify,
  onSuccess,
  onCancel,
  onLockout,
}: {
  length: number;
  verify: (pin: string) => Promise<UnenrolResult>;
  onSuccess: () => void;
  onCancel: () => void;
  onLockout: () => void;
}) {
  const [s, dispatch] = useReducer(
    (st: PinPadState, e: PinPadEvent) => pinPadReducer(st, e, length),
    { digits: "", wrong: 0, error: null },
  );
  useEffect(() => {
    if (s.digits.length !== length) return;
    let cancelled = false;
    void verify(s.digits).then((result) => {
      if (cancelled) return;
      if (result === "ok") onSuccess();
      else if (result === "wrong") {
        if (s.wrong + 1 >= PIN_MAX_WRONG) onLockout();
        else dispatch({ type: "wrong" });
      } else {
        const text =
          result === "limited"
            ? t("Too many tries — wait a few minutes")
            : result === "offline"
              ? t("Leaving needs a connection")
              : t("Could not leave kiosk mode");
        dispatch({ type: "message", text });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [s.digits, s.wrong, length, verify, onSuccess, onLockout]);

  const key = (k: string) => (
    <button
      key={k}
      type="button"
      onClick={() => dispatch({ type: "digit", d: k })}
      className={cn(
        "flex h-[72px] w-[72px] items-center justify-center rounded-full border border-line bg-surface-2 text-[26px] font-bold text-ink active:scale-95",
        focusRing,
      )}
    >
      {k}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Leave kiosk mode")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    >
      <div className="flex w-[360px] flex-col items-center gap-5 rounded-3xl border border-line bg-bg px-8 pt-7 pb-6">
        <div className="flex flex-col items-center gap-1.5">
          <IconLock className="h-7 w-7 text-accent" />
          <p className="text-lg font-bold text-ink">{t("Leave kiosk mode")}</p>
          <p className="text-sm text-muted" role="status">
            {s.error ?? t("Enter the kiosk PIN")}
          </p>
        </div>
        {/* The dots are decoration; the status line above announces the
            state, and the digit count is visible in the dots themselves. */}
        <div
          aria-hidden="true"
          className={cn("flex gap-3.5", s.error && "animate-pulse-soft")}
        >
          {Array.from({ length }, (_, i) => (
            <span
              key={`dot-${i.toString()}`}
              className={cn(
                "h-3.5 w-3.5 rounded-full border-2 border-accent",
                i < s.digits.length && "bg-accent",
              )}
            />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3.5">
          {KEYS.map(key)}
          <span />
          {key("0")}
          <button
            type="button"
            aria-label={t("Backspace")}
            onClick={() => dispatch({ type: "backspace" })}
            className={cn(
              "flex h-[72px] w-[72px] items-center justify-center rounded-full text-ink-soft",
              focusRing,
            )}
          >
            <IconBackspace className="h-[26px] w-[26px]" />
          </button>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "h-11 px-4 text-sm font-semibold text-muted",
            focusRing,
          )}
        >
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}
