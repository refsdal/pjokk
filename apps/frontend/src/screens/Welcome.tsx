import { Navigate, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client, unwrap } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { t } from "@/lib/i18n";
import { toLocalDateInput } from "@/lib/time";
import { toast } from "@/lib/toast";
import { PlanStep } from "./WelcomePlan";

// Family founders land here once (everyone else arrives via /join/CODE).
// Two steps on one screen: name the family, then add the baby.
export function WelcomeScreen() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hasFamily = !!session?.session.activeOrganizationId;

  const [familyName, setFamilyName] = useState("");
  const [babyName, setBabyName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [sex, setSex] = useState<"girl" | "boy" | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!isPending && !session) {
    return <Navigate to="/login" />;
  }

  const createFamily = async () => {
    setBusy(true);
    try {
      const slug = `${
        familyName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "family"
      }-${Math.random().toString(36).slice(2, 7)}`;
      const { data, error } = await authClient.organization.create({
        name: familyName.trim(),
        slug,
      });
      if (error || !data) {
        throw new Error(error?.message ?? "Could not create family");
      }
      await authClient.organization.setActive({ organizationId: data.id });
      await queryClient.invalidateQueries();
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const createBaby = async () => {
    setBusy(true);
    try {
      await unwrap(
        client.POST("/api/babies", {
          body: {
            name: babyName.trim(),
            birthDate: new Date(birthDate).toISOString(),
            ...(sex ? { sex } : {}),
          },
        }),
      );
      await queryClient.invalidateQueries();
      setShowPlan(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 pb-safe pt-safe">
      <div className="text-center">
        <img src="/icon.svg" alt="" className="mx-auto h-16 w-16" />
        <h1 className="mt-2 text-2xl font-extrabold text-ink">
          {!hasFamily
            ? t("Set up your family")
            : showPlan
              ? t("Choose your plan")
              : t("Who are we tracking?")}
        </h1>
      </div>

      {hasFamily && showPlan ? (
        <PlanStep
          familyId={session?.session.activeOrganizationId ?? ""}
          onFree={() => void navigate({ to: "/home" })}
        />
      ) : !hasFamily ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void createFamily();
          }}
        >
          <Input
            placeholder={t("Family name (e.g. “The Olsens”)")}
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
          />
          <Button
            size="full"
            type="submit"
            disabled={busy || familyName.trim().length === 0}
          >
            {t("Create family")}
          </Button>

          <div className="space-y-2 pt-6 text-center">
            <p className="text-sm font-semibold text-ink-soft">
              {t("Invited to a family?")}
            </p>
            <p className="text-sm text-muted">
              {t(
                "Open the invite link (or scan the QR) from your family's admin to join them instead.",
              )}
            </p>
            <button
              type="button"
              className="text-sm text-muted underline"
              onClick={() =>
                void authClient
                  .signOut()
                  .then(() => window.location.assign("/login"))
              }
            >
              {t("Sign out")}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void createBaby();
          }}
        >
          <Input
            placeholder={t("Baby's name")}
            value={babyName}
            onChange={(e) => setBabyName(e.target.value)}
          />
          <ChipGroup
            options={[
              { value: "girl", label: t("Girl") },
              { value: "boy", label: t("Boy") },
            ]}
            value={sex}
            onChange={setSex}
          />
          <label className="block text-sm font-medium text-ink-soft">
            {t("Birth date")}
            <input
              type="date"
              value={birthDate}
              max={toLocalDateInput()}
              onChange={(e) => setBirthDate(e.target.value)}
              className="mt-1 h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
            />
          </label>
          <Button
            size="full"
            type="submit"
            disabled={busy || babyName.trim().length === 0 || !birthDate}
          >
            {t("Add baby")}
          </Button>
        </form>
      )}
    </div>
  );
}
