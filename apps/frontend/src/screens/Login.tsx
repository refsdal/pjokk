import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn, signUp, useSession } from "@/lib/auth-client";
import { useConfig } from "@/lib/data";
import { t } from "@/lib/i18n";
import { oauthProviderLabels } from "@/lib/oauth";
import { legalUrl } from "@/lib/site";
import { toast } from "@/lib/toast";

// The provider list is a stacked column on purpose: a third button (Apple)
// drops in without rework if a store build ever ships.
export function LoginScreen({ redirectTo = "/home" }: { redirectTo?: string }) {
  const { data: session, isPending } = useSession();
  const config = useConfig();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "create">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!isPending && session) {
    return <Navigate to={redirectTo} />;
  }

  const providers = config.data?.oauthProviders ?? [];
  // Bootstrap credential signup only exists while OPEN_SIGNUP is on — same
  // gate the server enforces (apps/server/internal/auth/auth.go). Once it's
  // off, `mode` can never reach "create" because the only control that sets
  // it is itself gated on this flag.
  const canCreate = config.data?.openSignup ?? false;

  // Limen's OAuth flow hands the browser to the provider and comes back to
  // `redirectTo`; there is no promise to await past the navigation, so the
  // only failure this can report is the authorize call itself.
  const oauthSignIn = async (provider: string) => {
    try {
      await signIn.social(provider, redirectTo);
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Sign-in failed"), "error");
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "create") {
        // signUp.credential already establishes the session (Limen writes
        // it into the same store useSession() reads, synchronously, before
        // this resolves) and resets the cache itself — a follow-up
        // signIn.password would be a redundant re-auth racing the
        // <Navigate> that useSession()'s re-render already mounted by the
        // time it ran.
        await signUp.credential(email, password);
      } else {
        await signIn.password(email, password);
      }
      void navigate({ to: redirectTo });
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Sign-in failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 pb-safe pt-safe">
      <div className="text-center">
        <img src="/icon.svg" alt="" className="mx-auto h-20 w-20" />
        <h1 className="mt-3 text-3xl font-extrabold text-ink">Pjokk</h1>
        <p className="mt-1 text-sm text-muted">{t("Family baby tracker")}</p>
      </div>

      {providers.length > 0 && (
        <div className="space-y-3">
          {providers.map((provider) => (
            <Button
              key={provider}
              size="full"
              variant="outline"
              onClick={() => void oauthSignIn(provider)}
            >
              {t(oauthProviderLabels[provider] ?? provider)}
            </Button>
          ))}
          {/* Apple lands here if a store build ever requires it. */}
        </div>
      )}

      {providers.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-muted">
          <div className="h-px flex-1 bg-line" />
          {t("or")}
          <div className="h-px flex-1 bg-line" />
        </div>
      )}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          type="email"
          placeholder={t("Email")}
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          placeholder={t("Password")}
          autoComplete={mode === "create" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button size="full" variant="secondary" disabled={busy} type="submit">
          {mode === "create" ? t("Create account") : t("Sign in with email")}
        </Button>
      </form>

      {canCreate && (
        <p className="text-center text-xs text-muted">
          {mode === "signin" ? (
            <button
              type="button"
              className="font-semibold text-accent"
              onClick={() => setMode("create")}
            >
              {t("Create account")}
            </button>
          ) : (
            <button
              type="button"
              className="font-semibold text-accent"
              onClick={() => setMode("signin")}
            >
              {t("Have an account? Sign in")}
            </button>
          )}
        </p>
      )}

      <p className="text-center text-xs text-muted">
        {t("Pjokk is invite-only. Ask a family admin for an invite link.")}
      </p>

      {/* Plain anchors, not <Link>: these pages left the SPA in the landing
          split (PR #17) and now live on the public apex. */}
      <p className="flex justify-center gap-4 text-xs font-semibold text-muted">
        <a href={legalUrl("privacy")}>{t("Privacy policy")}</a>
        <a href={legalUrl("terms")}>{t("Terms")}</a>
      </p>
    </div>
  );
}
