import { useEffect } from "react";

// The app badge (issue #51): the installed icon carries a dot while a
// session is running, so the icon itself is the status card. Android,
// desktop Chrome and iOS 16.4+ installed PWAs; everywhere else the API is
// simply absent and this is a no-op.

type BadgeHost = {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Set (a plain dot) or clear the badge; never throws — a denied badge is not worth a toast. */
export async function syncAppBadge(
  active: boolean,
  host: BadgeHost | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as BadgeHost),
): Promise<boolean> {
  if (!host?.setAppBadge || !host.clearAppBadge) return false;
  try {
    if (active) await host.setAppBadge();
    else await host.clearAppBadge();
    return true;
  } catch {
    return false;
  }
}

/** Keeps the badge in step with `active`, and clears it when the caller unmounts (sign-out, family switch). */
export function useAppBadge(active: boolean): void {
  useEffect(() => {
    void syncAppBadge(active);
  }, [active]);
  useEffect(() => {
    return () => {
      void syncAppBadge(false);
    };
  }, []);
}
