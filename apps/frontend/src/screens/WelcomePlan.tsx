import { useState } from "react";
import type { CSSProperties } from "react";
import { IconCheck } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { api, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type PlanChoice = "free" | "monthly" | "yearly" | "lifetime";

const PLANS: {
  id: PlanChoice;
  name: string;
  price: string;
  badge?: string;
}[] = [
  { id: "free", name: "Free", price: "0 kr" },
  { id: "monthly", name: "Premium monthly", price: "20 kr/mo" },
  {
    id: "yearly",
    name: "Premium yearly",
    price: "200 kr/yr",
    badge: "2 months free",
  },
  { id: "lifetime", name: "Premium lifetime", price: "400 kr" },
];

const FREE_FEATURES = [
  "1 baby",
  "Feeds, sleep & diapers",
  "Medicine log",
  "Timeline & full history",
  "Week stats",
  "Reminders & night mode",
];
const PREMIUM_FEATURES = [
  "More babies",
  "Bath, notes, milestones & more",
  "Growth charts (WHO)",
  "Month stats",
  "CSV export",
  "API keys",
];

function Feature({
  label,
  on,
  delayMs,
}: {
  label: string;
  on: boolean;
  delayMs: number;
}) {
  return (
    <div
      className="flex items-center gap-2.5"
      style={{ "--d": `${delayMs}ms` } as CSSProperties}
    >
      <span className="relative h-[18px] w-[18px] shrink-0">
        <IconCheck
          className={`plan-check absolute inset-0 h-[18px] w-[18px] text-accent${on ? " on" : ""}`}
          stroke={2.5}
          aria-hidden
        />
        <span
          className={`plan-circle absolute inset-0 rounded-full border-[1.5px] border-line${on ? " on" : ""}`}
        />
      </span>
      <span className={`plan-label text-sm ${on ? "text-ink" : "text-muted"}`}>
        {t(label)}
      </span>
    </div>
  );
}

// The third Welcome step: pick a plan for the freshly created family. Free
// is the default and just proceeds; paid choices leave for Stripe Checkout
// (the family exists either way — cancelling checkout is not a dead end).
export function PlanStep({
  familyId,
  onFree,
}: {
  familyId: string;
  onFree: () => void;
}) {
  const [plan, setPlan] = useState<PlanChoice>("free");
  const [busy, setBusy] = useState(false);
  const premium = plan !== "free";

  const proceed = async () => {
    if (plan === "free") {
      onFree();
      return;
    }
    setBusy(true);
    try {
      if (plan === "lifetime") {
        const { url } = await unwrap<{ url: string }>(
          await api.billing.lifetime.$post(),
        );
        window.location.assign(url);
        return;
      }
      const { error } = await authClient.subscription.upgrade({
        plan: "premium",
        annual: plan === "yearly",
        referenceId: familyId,
        customerType: "organization",
        successUrl: "/settings?billing=success",
        // Abandoning checkout lands in the app, not on the marketing page.
        cancelUrl: "/home",
      });
      if (error) {
        throw new Error(error.message ?? t("Something went wrong"));
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Failed"), "error");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-center text-sm text-muted">
        {t("You can change this anytime in Settings.")}
      </p>

      <fieldset className="space-y-2">
        <legend className="sr-only">{t("Choose your plan")}</legend>
        {PLANS.map((p) => {
          const selected = p.id === plan;
          return (
            <label
              key={p.id}
              className={`flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-xl2 bg-surface text-left transition-colors ${
                selected
                  ? "border-2 border-accent px-[13px]"
                  : "border border-line px-3.5"
              }`}
            >
              <input
                type="radio"
                name="plan"
                className="sr-only"
                checked={selected}
                onChange={() => setPlan(p.id)}
              />
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  selected
                    ? "plan-radio-on border-accent bg-accent"
                    : "border-line"
                }`}
              >
                {selected && (
                  <IconCheck
                    className="h-3 w-3 text-on-accent"
                    stroke={3}
                    aria-hidden
                  />
                )}
              </span>
              <span className="flex flex-1 items-center gap-2">
                <span className="text-[15px] font-bold text-ink">
                  {t(p.name)}
                </span>
                {p.badge && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent">
                    {t(p.badge)}
                  </span>
                )}
              </span>
              <span className="text-sm font-bold text-ink">{t(p.price)}</span>
            </label>
          );
        })}
      </fieldset>

      <div className="space-y-2.5 rounded-xl2 border border-line bg-surface p-4">
        <p className="text-xs font-bold tracking-wide text-muted uppercase">
          {premium ? t("Included with Premium") : t("Included with Free")}
        </p>
        <div className="space-y-2">
          {FREE_FEATURES.map((label) => (
            <Feature key={label} label={label} on delayMs={0} />
          ))}
          {PREMIUM_FEATURES.map((label, i) => (
            <Feature
              key={label}
              label={label}
              on={premium}
              // Checking cascades top-down; unchecking cascades bottom-up.
              delayMs={(premium ? i : PREMIUM_FEATURES.length - 1 - i) * 80}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Button size="full" disabled={busy} onClick={() => void proceed()}>
          {premium ? t("Continue to checkout") : t("Start tracking")}
        </Button>
        <p className="text-center text-xs text-muted">
          {t("Paid plans continue to secure checkout with Stripe.")}
        </p>
      </div>
    </div>
  );
}
