import { Navigate, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

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
  const [busy, setBusy] = useState(false);

  if (!isPending && !session) {
    return <Navigate to="/login" />;
  }

  const createFamily = async () => {
    setBusy(true);
    try {
      const slug = `${familyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "family"}-${Math.random().toString(36).slice(2, 7)}`;
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
        await api.babies.$post({
          json: {
            name: babyName.trim(),
            birthDate: new Date(birthDate).toISOString(),
          },
        }),
      );
      await queryClient.invalidateQueries();
      void navigate({ to: "/" });
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
          {hasFamily ? t("Who are we tracking?") : t("Set up your family")}
        </h1>
      </div>

      {!hasFamily ? (
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
          <label className="block text-sm font-medium text-ink-soft">
            {t("Birth date")}
            <input
              type="date"
              value={birthDate}
              max={new Date().toISOString().slice(0, 10)}
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
