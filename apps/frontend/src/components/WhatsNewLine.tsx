import { IconSparkles, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { whatsNew } from "@/data/whats-new";
// The barrel, not "@/lib/data/profile": lib/data/index.ts re-exports it,
// and every screen imports profile hooks from there.
import { useBabies, useMe, useSaveWhatsNew } from "@/lib/data";
import { t } from "@/lib/i18n";
import { familyTracks } from "@/lib/tracking";
import { highestSeq, pending } from "@/lib/whats-new";

// One quiet line at the foot of Home (issue #140), in the ClosedDayLine
// idiom. Rendered only in day-mode Home, which is why there is no night
// check here: Home returns early into NightHome, so this subtree does not
// exist at 03:00.
//
// The x is the point. Dismissing must never require opening anything — the
// person who opened the app to log a bottle taps once and it is gone. It
// can be that aggressive because dismissal loses nothing: /whats-new keeps
// every entry (spec §7).
export function WhatsNewLine() {
  const me = useMe();
  const babies = useBabies();
  const navigate = useNavigate();
  const save = useSaveWhatsNew();

  // Latches shut the instant this tap fires (see markSeen), same idiom as
  // shell.tsx's sawOnboarded: the PATCH is optimistic-then-async, but
  // useMe refetches on every mount ("always"), so navigating away and back
  // to Home before it lands can resolve a GET taken BEFORE the PATCH
  // committed — the pre-dismissal whatsNewSeq — and without this, that
  // stale response would resurrect the row the person already dismissed.
  const dismissedThisSession = useRef(false);

  const seq = me.data?.whatsNewSeq;
  if (seq === undefined || dismissedThisSession.current) return null;

  const unseen = pending(whatsNew(), seq, (k) => familyTracks(babies.data, k));
  if (unseen.length === 0) return null;

  // Over the UNFILTERED list: see highestSeq's comment.
  const markSeen = () => {
    dismissedThisSession.current = true;
    save.mutate({ whatsNewSeq: highestSeq(whatsNew()) });
  };

  return (
    <div className="px-4 pb-3" data-testid="whats-new-line">
      <div className="flex items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-accent">
          <IconSparkles className="h-4 w-4" />
        </span>
        <button
          type="button"
          className="flex min-h-11 flex-1 items-center text-left font-semibold text-ink"
          data-testid="whats-new-open"
          onClick={() => {
            markSeen();
            void navigate({ to: "/whats-new" });
          }}
        >
          {unseen.length === 1
            ? t("1 new thing since you were away")
            : `${unseen.length} ${t("new things since you were away")}`}
        </button>
        <button
          type="button"
          // 44 px minimum touch target: this is a one-handed, half-asleep
          // tap and missing it means opening a screen nobody asked for.
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted"
          data-testid="whats-new-dismiss"
          aria-label={t("Dismiss what's new")}
          onClick={markSeen}
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
