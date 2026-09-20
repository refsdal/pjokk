import { Navigate, useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { Carousel } from "@/components/Carousel";
import { gettingStarted, whatsNew } from "@/data/whats-new";
import { useSession } from "@/lib/auth-client";
import { useMe, useSaveWhatsNew } from "@/lib/data";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { highestSeq } from "@/lib/whats-new";

// The first run (issue #140), for someone who arrived by invite and has
// never seen the app. Full-screen and paced, unlike anything a RETURNING
// caretaker ever sees: the cost of a tutorial is a function of when it
// appears, and setting the app up is the one moment when it is near zero.
//
// Skip is as prominent as Done on purpose. Someone who wants to get on with
// it must be able to, in one tap.
export function GettingStartedScreen() {
  // Parented at rootRoute like /welcome, so it carries no session gate of
  // its own — a signed-out visitor could otherwise open it directly and
  // have Skip 401. Same check as Welcome.tsx.
  const { data: session, isPending } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const save = useSaveWhatsNew();
  // Capture whether this is a genuine first run at mount time. A ref, not
  // derived state: by the time finish() runs, the optimistic update may
  // already have flipped onboarded to true. Initialize to null so a slow
  // first paint doesn't misclassify a genuine first run as a re-run — only
  // latch once me.data exists.
  const isFirstRun = useRef<boolean | null>(null);
  if (me.data && isFirstRun.current === null) {
    isFirstRun.current = me.data.onboarded === false;
  }

  if (isPending) {
    return <div className="min-h-dvh" />;
  }
  if (!session) {
    return <Navigate to="/login" />;
  }

  // Finishing marks the onboarded flag. For a genuine first run, also mark
  // the release notes caught up: a brand-new account must never be shown
  // what changed in versions it never missed. But re-running the tour out
  // of curiosity should not mark release notes as read.
  const finish = () => {
    save.mutate(
      isFirstRun.current === true
        ? { onboarded: true, whatsNewSeq: highestSeq(whatsNew()) }
        : { onboarded: true },
    );
    void navigate({ to: "/home" });
  };

  // Already-translated strings from gettingStarted(); never re-wrap in t().
  const steps = gettingStarted().map((card) => {
    const Icon = card.icon;
    return (
      <section
        key={card.key}
        className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
        data-testid={`getting-started-card-${card.key}`}
      >
        <span
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-full bg-surface-2",
            card.tint,
          )}
        >
          <Icon className="h-8 w-8" />
        </span>
        <h2 className="text-2xl font-extrabold text-ink">{card.title}</h2>
        <p className="max-w-xs text-ink-soft">{card.body}</p>
      </section>
    );
  });

  return (
    <div className="relative min-h-dvh">
      <button
        type="button"
        className="absolute right-4 z-10 rounded-full px-4 py-2 font-semibold text-muted"
        style={{ top: "env(safe-area-inset-top, 0px)" }}
        data-testid="getting-started-skip"
        onClick={finish}
      >
        {t("Skip")}
      </button>
      <Carousel
        steps={steps}
        onFinish={finish}
        testIdPrefix="getting-started"
        finishLabel={t("Start using Pjokk")}
        ariaLabel={t("Getting started")}
      />
    </div>
  );
}
