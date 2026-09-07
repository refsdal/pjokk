import { IconAlertTriangle } from "@tabler/icons-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { queryClient, resetCache } from "@/lib/query";

// The last line of defence for a render error. Two ways in: the router's
// defaultErrorComponent (a screen that throws while rendering) and the
// ErrorBoundary class around the whole app (anything outside a route).
// The screen offers the three recoveries in the order they are likely to
// help: remount the screen, reload the app, and — for the class of bug
// that motivated this (a persisted snapshot older than the code reading
// it) — drop the saved data and reload, which keeps the session.
export function AppErrorScreen({
  error,
  reset,
}: {
  error: unknown;
  reset?: () => void;
}) {
  const clearAndReload = async () => {
    try {
      await resetCache();
    } finally {
      window.location.reload();
    }
  };
  // Remounting alone re-renders whatever data the screen crashed on; drop
  // the in-memory query data first so the screen comes back on a fresh
  // fetch. (The on-disk snapshot is rewritten from this fresh state.)
  const tryAgain = () => {
    void queryClient.resetQueries().finally(() => reset?.());
  };
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-caution">
        <IconAlertTriangle className="h-7 w-7" />
      </span>
      <h1 className="text-xl font-extrabold text-ink">
        {t("Something went wrong")}
      </h1>
      <p className="text-sm text-muted">
        {t("Nothing you logged is lost. Try again, or reload the app.")}
      </p>
      <p className="max-w-full rounded-xl2 bg-surface-2 px-3 py-2 font-mono text-[11px] break-words text-muted">
        {errorMessage(error)}
      </p>
      <div className="flex w-full flex-col gap-2 pt-2">
        {reset && (
          <Button size="full" onClick={tryAgain}>
            {t("Try again")}
          </Button>
        )}
        <Button
          size="full"
          variant="outline"
          onClick={() => window.location.reload()}
        >
          {t("Reload the app")}
        </Button>
        <Button
          size="full"
          variant="outline"
          onClick={() => void clearAndReload()}
        >
          {t("Clear saved data and reload")}
        </Button>
        <p className="text-xs text-muted">
          {t(
            "Clearing saved data keeps you signed in; unsent entries queued offline are discarded.",
          )}
        </p>
      </div>
    </div>
  );
}

type State = { error: unknown; failed: boolean };

// Class component: React still has no hook for catching render errors.
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("Pjokk crashed:", error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <AppErrorScreen
          error={this.state.error}
          reset={() => this.setState({ error: null, failed: false })}
        />
      );
    }
    return this.props.children;
  }
}
