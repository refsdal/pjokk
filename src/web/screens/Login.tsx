import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn, useSession } from "@/lib/auth-client";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

// The provider list is a stacked column on purpose: a third button (Apple)
// drops in without rework if a store build ever ships.
export function LoginScreen({ redirectTo = "/" }: { redirectTo?: string }) {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!isPending && session) {
    return <Navigate to={redirectTo} />;
  }

  const google = async () => {
    try {
      const { error } = await signIn.social({
        provider: "google",
        callbackURL: redirectTo,
      });
      if (error) throw new Error(error.message ?? t("Sign-in failed"));
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Sign-in failed"), "error");
    }
  };

  const emailSignIn = async () => {
    setBusy(true);
    const { error } = await signIn.email({ email, password });
    setBusy(false);
    if (error) {
      toast(error.message ?? t("Sign-in failed"), "error");
      return;
    }
    void navigate({ to: redirectTo });
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
    </div>
  );
}
