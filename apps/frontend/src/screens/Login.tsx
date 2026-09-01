import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn, useSession } from "@/lib/auth-client";
import { t } from "@/lib/i18n";
import { legalUrl } from "@/lib/site";
import { toast } from "@/lib/toast";

// The provider list is a stacked column on purpose: a third button (Apple)
// drops in without rework if a store build ever ships.
export function LoginScreen({ redirectTo = "/home" }: { redirectTo?: string }) {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!isPending && session) {
    return <Navigate to={redirectTo} />;
  }

  // Limen's OAuth flow hands the browser to Google and comes back to
  // `redirectTo`; there is no promise to await past the navigation, so the
  // only failure this can report is the authorize call itself.
  const google = async () => {
    try {
      await signIn.google(redirectTo);
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Sign-in failed"), "error");
    }
  };

  const emailSignIn = async () => {
    setBusy(true);
    try {
      await signIn.password(email, password);
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

      <div className="space-y-3">
        <Button size="full" variant="outline" onClick={google}>
          {t("Continue with Google")}
        </Button>
        {/* Apple lands here if a store build ever requires it. */}
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        <div className="h-px flex-1 bg-line" />
        {t("or")}
        <div className="h-px flex-1 bg-line" />
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void emailSignIn();
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
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button size="full" variant="secondary" disabled={busy} type="submit">
          {t("Sign in with email")}
        </Button>
      </form>

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
