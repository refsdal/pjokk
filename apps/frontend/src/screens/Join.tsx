import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "@/components/QueryStates";
import { Button } from "@/components/ui/button";
import { client, unwrap } from "@/lib/api";
import { authClient, signIn, useSession } from "@/lib/auth-client";
import { useConfig } from "@/lib/data";
import { t } from "@/lib/i18n";
import { oauthProviderLabels } from "@/lib/oauth";
import { legalUrl } from "@/lib/site";
import { toast } from "@/lib/toast";

interface InviteInfo {
  valid: boolean;
  familyName: string | null;
  role: "admin" | "member" | null;
  reason: string | null;
}

// The /join/CODE flow IS onboarding: open link (or QR) → sign in → join →
// land on the family home.
export function JoinScreen() {
  const { code } = useParams({ from: "/join/$code" });
  const { data: session, isPending } = useSession();
  const config = useConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Guards the auto-redeem effect below so it fires at most once per mount,
  // regardless of how many times session/info/busy re-render it.
  const didAuto = useRef(false);

  const info = useQuery({
    queryKey: ["invite-info", code],
    queryFn: async () =>
      unwrap<InviteInfo>(
        client.GET("/api/invites/info/{code}", {
          params: { path: { code } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });

  const joinPath = `/join/${code}`;
  const providers = config.data?.oauthProviders ?? [];

  // Signup is closed everywhere EXCEPT through this flow. better-auth took
  // a per-call `requestSignUp` flag for that; Limen has no client-side
  // equivalent — the Go OAuth callback decides whether an unknown account
  // may be created for any given provider.
  const oauthSignIn = async (provider: string) => {
    try {
      await signIn.social(provider, joinPath);
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Sign-in failed"), "error");
    }
  };

  const redeem = async () => {
    setBusy(true);
    try {
      const result = await unwrap<{ familyId: string; familyName: string }>(
        client.POST("/api/invites/redeem", { body: { code } }),
      );
      // The redeem handler already switches the session to the new family
      // (setActiveFamilyBestEffort), but that is explicitly best-effort and
      // non-fatal server-side, so ask again from here. A failure is not worth
      // failing the join over — the membership row is written either way, and
      // the family switcher can recover it.
      try {
        await authClient.organization.switch({ id: result.familyId });
      } catch {
        // Ignored on purpose: see above.
      }
      await queryClient.invalidateQueries();
      toast(t("Welcome to ") + result.familyName);
      void navigate({ to: "/home" });
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Join failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  // Auto-redeem: a signed-in visitor with a valid invite shouldn't have to
  // click "Join family" — the whole point of the link (or QR code) is that
  // opening it is the action. Runs exactly once per mount (didAuto is never
  // reset): a persistent failure — invite hit maxUses, a 500, offline — must
  // not retry itself against a rate-limited endpoint. The manual button below
  // is gated only on `busy`, never on `didAuto`, so it stays the retry path
  // for a failed auto-redeem and the fallback for the
  // already-signed-in-different-family case.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redeem is a new closure every render; the didAuto ref already guards against firing more than once
  useEffect(() => {
    if (didAuto.current) return;
    if (session && info.data?.valid && !busy) {
      didAuto.current = true;
      void redeem();
    }
  }, [session, info.data?.valid, busy]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 pb-safe pt-safe text-center">
      <img src="/icon.svg" alt="" className="mx-auto h-16 w-16" />

      {info.isLoading && <p className="text-muted">{t("Checking invite…")}</p>}

      {info.isError && <ErrorState onRetry={() => void info.refetch()} />}

      {info.data && !info.data.valid && (
        <>
          <h1 className="text-2xl font-extrabold text-ink">
            {t("Invite not valid")}
          </h1>
          <p className="text-sm text-muted">
            {t("This invite link is ")}
            {info.data.reason ?? t("invalid")}
            {t(". Ask for a fresh one.")}
          </p>
        </>
      )}

      {info.data?.valid && (
        <>
          <h1 className="text-2xl font-extrabold text-ink">
            {t("Join ")}
            {info.data.familyName}
          </h1>
          <p className="text-sm text-muted">
            {t("You are invited as ")}
            <span className="font-semibold">{info.data.role}</span>.
          </p>

          {isPending ? null : session ? (
            <Button size="full" onClick={() => void redeem()} disabled={busy}>
              {busy ? t("Joining…") : t("Join family")}
            </Button>
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <Button
                  key={provider}
                  size="full"
                  onClick={() => void oauthSignIn(provider)}
                >
                  {t(oauthProviderLabels[provider] ?? provider)}
                </Button>
              ))}
              <p className="text-xs text-muted">
                {t("Already have an account?")}{" "}
                <Link
                  to="/login"
                  search={{ redirect: joinPath }}
                  className="font-semibold text-accent"
                >
                  {t("Sign in")}
                </Link>
              </p>
            </div>
          )}

          {/* Shown at the moment of consent, not buried in Settings: joining
              a family means recording a child's health information.
              Plain anchors, not <Link>: these pages left the SPA in the
              landing split (PR #17) and now live on the public apex. */}
          <p className="text-xs leading-relaxed text-muted">
            {t("By joining you accept our")}{" "}
            <a href={legalUrl("terms")} className="font-semibold text-accent">
              {t("Terms")}
            </a>{" "}
            {t("and")}{" "}
            <a href={legalUrl("privacy")} className="font-semibold text-accent">
              {t("Privacy policy")}
            </a>
            {t(
              ", including that Pjokk stores health information about your child.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
