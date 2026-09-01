import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_BASE, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useFamily } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  premium: "Premium",
  lifetime: "Premium · lifetime",
  comp: "Premium · complimentary",
};

export function BillingSection({ isAdmin }: { isAdmin: boolean }) {
  const family = useFamily();
  const queryClient = useQueryClient();
  const plan = family.data?.plan ?? "free";
  const handled = useRef(false);

  // Checkout return: the webhook can lag the redirect, so poll briefly
  // until the plan flips before celebrating.
  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("billing");
    if (!outcome) return;
    handled.current = true;
    params.delete("billing");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
    if (outcome !== "success") return;
    toast(t("Payment received — welcome to Premium!"));
    let tries = 0;
    const tick = () => {
      void queryClient.invalidateQueries({ queryKey: ["family"] }).then(() => {
        tries += 1;
        const current = queryClient.getQueryData<{ plan: string }>(["family"]);
        if ((current?.plan ?? "free") === "free" && tries < 5) {
          setTimeout(tick, 2000);
        }
      });
    };
    tick();
  }, [queryClient]);

  const subscribe = async (annual: boolean) => {
    if (!family.data) return;
    const { error } = await authClient.subscription.upgrade({
      plan: "premium",
      annual,
      referenceId: family.data.id,
      customerType: "organization",
      successUrl: "/settings?billing=success",
      cancelUrl: "/settings?billing=canceled",
    });
    if (error) toast(error.message ?? t("Something went wrong"), "error");
  };

  const buyLifetime = async () => {
    try {
      // NOTE (Task 25): the Go backend has no billing routes at all —
      // "Billing is gone" (internal/api/admin.go). There is no
      // /api/billing/lifetime in openapi/pjokk.yaml to generate a typed
      // call for, so this stays a raw fetch (same bypass pattern as the
      // vaccine-document routes in lib/data/vaccines.ts) rather than an
      // invented client.POST call. It will 404 until Task 27 removes this
      // component entirely (REF §A8 "Billing removal").
      const res = await fetch(`${API_BASE}/api/billing/lifetime`, {
        method: "POST",
        credentials: "include",
      });
      const { url } = await unwrap<{ url: string }>(res);
      window.location.assign(url);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const manage = async () => {
    if (!family.data) return;
    const { error } = await authClient.subscription.billingPortal({
      referenceId: family.data.id,
      customerType: "organization",
      returnUrl: "/settings",
    });
    if (error) toast(error.message ?? t("Something went wrong"), "error");
  };

  return (
    <>
      <SectionTitle>{t("Plan")}</SectionTitle>
      <Card id="billing" className="space-y-3">
        <p className="text-sm text-ink-soft">
          {t("Current plan")}
          <span className="block text-base font-bold text-ink">
            {t(PLAN_LABEL[plan] ?? plan)}
          </span>
        </p>

        {plan === "free" && (
          <>
            <p className="text-sm text-muted">
              {t(
                "Premium unlocks more babies, all activity types, growth charts, month stats, CSV export and API keys.",
              )}
            </p>
            {isAdmin ? (
              <div className="space-y-2">
                <Button size="full" onClick={() => void subscribe(false)}>
                  {t("Premium monthly — 20 kr/mo")}
                </Button>
                <Button
                  size="full"
                  variant="outline"
                  onClick={() => void subscribe(true)}
                >
                  {t("Premium yearly — 200 kr/yr")}
                </Button>
                <Button
                  size="full"
                  variant="outline"
                  onClick={() => void buyLifetime()}
                >
                  {t("Lifetime — 400 kr once")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted">
                {t("Ask a family admin to upgrade.")}
              </p>
            )}
          </>
        )}

        {plan === "premium" && isAdmin && (
          <Button size="full" variant="outline" onClick={() => void manage()}>
            {t("Manage subscription")}
          </Button>
        )}
      </Card>
    </>
  );
}
