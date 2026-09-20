import { type ReactNode, useEffect, useRef } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Navigate, Outlet } from "@tanstack/react-router";
import { TabBar } from "@/components/TabBar";
import { client, unwrap } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useAppBadge } from "@/lib/badge";
import { useMe, useSummary } from "@/lib/data";
import { useLanguageSync } from "@/lib/data/profile";
import {
  judgeFamily,
  readFence,
  recordDiscarded,
  takeDiscarded,
  writeFence,
} from "@/lib/family-fence";
import { t } from "@/lib/i18n";
import { useKiosk } from "@/lib/kiosk";
import { queryClient, resetCache } from "@/lib/query";
import { useSelectedBaby } from "@/lib/selected-baby";
import { toast } from "@/lib/toast";

// Authed shell: session required; users without a family go to /welcome
// (the invite flow normally prevents that, but the family founder starts
// here). Appearance (theme + night mode) is provided at the router root.
//
// Two sources, deliberately: the Limen session store answers "is there a
// session at all", and GET /api/me answers everything about it — the active
// family and the impersonation banner included. Limen's own session payload
// has neither.
// Mounted only once the shell has a family: the selected baby's running
// sleep / play / nursing / pump session puts a dot on the installed icon
// (lib/badge.ts), and unmounting — sign-out, no family — clears it.
function AppBadge() {
  const { baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const s = summary.data;
  useAppBadge(
    !!s && !!(s.activeSleep || s.activePlay || s.activeFeed || s.activePump),
  );
  return null;
}

// Session + family guard shared by the app shell and the kiosk (spec §2).
// Renders `children` only once the session is known and the family is
// settled; otherwise the same blank / login / welcome handling as before.
export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const me = useMe();

  const familyId = me.data?.familyId ?? null;
  // Family fence (lib/family-fence.ts): a mismatch means the family behind
  // this session changed outside this tab's switch flow.
  useEffect(() => {
    const verdict = judgeFamily(readFence(), familyId);
    if (verdict === "recorded") writeFence(familyId as string);
    if (verdict === "changed") {
      // The server has already switched families by the time this device
      // notices, so any mutation still paused (queued offline) for the OLD
      // family can never be replayed against the new one. resetCache() must
      // still run — the alternative is serving the wrong family's cache —
      // but count what it is about to discard first, so the toast below (a
      // separate effect, fired once after the reload) can tell the person
      // rather than silently dropping their entry.
      const discarded = queryClient
        .getMutationCache()
        .getAll()
        .filter((m) => m.state.isPaused).length;
      recordDiscarded(discarded);
      void resetCache().then(() => window.location.reload());
    }
  }, [familyId]);

  useEffect(() => {
    const n = takeDiscarded();
    if (n > 0) {
      toast(
        t("Unsynced entries were discarded because the family changed"),
        "error",
      );
    }
  }, []);

  // me refetches on every mount (see useMe) — wait for THAT fetch to settle
  // before trusting familyId, so a reload never routes on the persisted
  // pre-family snapshot. isFetchedAfterMount flips true once the mount-fetch
  // resolves (offline: it settles as an error and the persisted value
  // stands, which is the offline-first contract).
  if (isPending || me.isPending || !me.isFetchedAfterMount) {
    return <div className="min-h-dvh" />;
  }
  if (!session) {
    return <Navigate to="/login" />;
  }
  if (!me.data?.familyId) {
    return <Navigate to="/welcome" />;
  }
  return <>{children}</>;
}

// While kiosk is on, the device IS the kiosk: every app route lands on the
// care station (a reload, a manifest shortcut, a push action). Checked
// BEFORE AuthGate: an enrolled tablet holds no person's session (spec
// 2026-09-10-kiosk-devices), so the session gate would otherwise send it to
// sign-in first. /login redirects it too; /join, /welcome and /admin are
// outside this shell and untouched.
export function AppShell() {
  const kiosk = useKiosk();
  if (kiosk) return <Navigate to="/kiosk" />;
  return (
    <AuthGate>
      <AppChrome />
    </AuthGate>
  );
}

function AppChrome() {
  const me = useMe();
  useLanguageSync();

  // The first run (issue #140). Here rather than in AuthGate because it
  // needs a settled `me`, and below the kiosk check in AppShell because an
  // enrolled tablet holds no person's session and must never land here.
  //
  // Founders never see it: Welcome.tsx sets onboarded when it creates the
  // baby, so they go on to the tracking carousel instead of being pulled
  // out of it into a second one.
  //
  // finishingFirstRun guards a real race, not a theoretical one: Done/Skip
  // fires the optimistic saveWhatsNew mutation and navigates to /home in
  // the same tick, but useMe refetches unconditionally on every mount
  // (staleTime 0, refetchOnMount "always" — lib/data/family.ts), and Home's
  // fresh mount under AppShell is exactly such a remount. If that GET
  // resolves before the PATCH does, it can overwrite the optimistic
  // onboarded:true with the server's still-false answer and bounce the
  // caretaker straight back into the tour they just finished — nothing else
  // would send them forward again, since this redirect only runs one way.
  // While the mutation is in flight — including a save PAUSED offline,
  // whose status stays "pending" until it replays — trust the optimistic
  // write over whatever the latest fetch says. The predicate narrows this
  // to a mutation that is actually FINISHING the first run: `saveWhatsNew`
  // also carries a bare what's-new dismissal (whatsNewSeq only, no
  // onboarded), which must not hold this guard up.
  const finishingFirstRun =
    useIsMutating({
      mutationKey: ["saveWhatsNew"],
      predicate: (m) =>
        (m.state.variables as { onboarded?: boolean } | undefined)
          ?.onboarded === true,
    }) > 0;
  const onboarded = me.data?.onboarded;

  // finishingFirstRun only covers the window while the mutation is in
  // flight. Once its PATCH response lands (onSuccess, isMutating drops to
  // 0), a STALE mount-triggered GET — issued after the PATCH started but
  // carrying a snapshot taken before it committed — can still resolve
  // afterwards and flip `me.onboarded` back to false with the guard
  // already down. The redirect is one-way, so without a latch that stale
  // response stranded the caretaker in a tour they had already finished.
  // Once this session has seen onboarded === true, trust it for good.
  const sawOnboarded = useRef(false);
  if (onboarded === true) sawOnboarded.current = true;

  const { impersonatedBy, name } = me.data ?? {};

  // The impersonated session IS the target user's, so ending it is a
  // session-level route rather than a system-admin one — and the cache has to
  // go with it, or the reload would restore the impersonated user's `me` and
  // bounce the operator straight back out of /admin.
  const stopImpersonating = async () => {
    try {
      await unwrap(client.POST("/api/admin/stop-impersonating"));
      await resetCache();
      window.location.assign("/admin");
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not stop impersonating",
        "error",
      );
    }
  };

  if (onboarded === false && !finishingFirstRun && !sawOnboarded.current) {
    return <Navigate to="/getting-started" />;
  }

  return (
    <div className="min-h-dvh">
      {impersonatedBy && (
        <div className="flex items-center justify-between gap-3 bg-danger px-4 py-2 pt-safe text-sm font-semibold text-white">
          <span>Impersonating {name}</span>
          <button
            type="button"
            className="rounded-full bg-white/20 px-3 py-1"
            onClick={() => void stopImpersonating()}
          >
            Stop
          </button>
        </div>
      )}
      <AppBadge />
      {/* md and up: clear the 88 px rail and cap the content at 1400 px
          (spec §1–2). Screens keep their own max-w inside this. */}
      <div className="md:pl-22">
        <div className="mx-auto max-w-[1400px]">
          <Outlet />
        </div>
      </div>
      <TabBar />
    </div>
  );
}
