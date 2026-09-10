import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppErrorScreen } from "@/components/ErrorBoundary";
import { Toaster } from "@/components/Toaster";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AppearanceProvider } from "@/lib/appearance";
import { t } from "@/lib/i18n";
import { HomeScreen } from "@/screens/Home";
import { JoinScreen } from "@/screens/Join";
import { KioskSetupScreen } from "@/screens/KioskSetup";
import { LoginScreen } from "@/screens/Login";
import { ProfileScreen } from "@/screens/Profile";
import { SettingsScreen } from "@/screens/settings";
import { AppShell } from "@/screens/shell";
import { TimelineScreen } from "@/screens/Timeline";
import { WelcomeScreen } from "@/screens/Welcome";

const rootRoute = createRootRoute({
  component: () => (
    <AppearanceProvider>
      <Outlet />
      <Toaster />
      <UpdateBanner />
    </AppearanceProvider>
  ),
});

// Authed four-tab shell.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

// The app's home screen lives at /home, not "/" — the tab bar, the
// active-session banner, and every internal link assume that path. "/"
// itself is handled separately, below (rootIndexRoute): it redirects here.
// ?log=feed|diaper|sleep|<other kind> opens that sheet on arrival — the
// manifest shortcuts and the push "log it now" actions land here (issue
// #51). Home clears it once the sheet is open so a reload does not reopen.
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/home",
  validateSearch: (search: Record<string, unknown>): { log?: string } =>
    typeof search.log === "string" ? { log: search.log } : {},
  component: HomeScreen,
});

const timelineRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/timeline",
  component: TimelineScreen,
});

// Lazy: recharts is heavy and only this tab needs it.
const statsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/stats",
  component: lazyRouteComponent(() => import("@/screens/Stats"), "StatsScreen"),
});

const calendarRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/calendar",
  component: lazyRouteComponent(
    () => import("@/screens/Calendar"),
    "CalendarScreen",
  ),
});

// Lazy: the bundled programme JSON only matters on this screen.
const vaccinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vaccines",
  component: lazyRouteComponent(
    () => import("@/screens/Vaccines"),
    "VaccinesScreen",
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsScreen,
});

// The person, not the family: reached from the account sheet on Home and
// from Settings → Account.
const profileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profile",
  component: ProfileScreen,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; notice?: string } => ({
    ...(typeof search.redirect === "string"
      ? { redirect: search.redirect }
      : {}),
    // "revoked": a kiosk tablet that lost its device (DeviceGate).
    ...(typeof search.notice === "string" ? { notice: search.notice } : {}),
  }),
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect, notice } = loginRoute.useSearch();
  return <LoginScreen redirectTo={redirect ?? "/home"} notice={notice} />;
}

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$code",
  component: JoinScreen,
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/welcome",
  component: WelcomeScreen,
});

// app.pjokk.no/ is the app's front door now that the landing page has moved
// to the apex (see CLAUDE.md, "everything lives on the apex" for the split).
// A top-level route, parented at rootRoute rather than appRoute: nesting it
// under appRoute would collide with the admin console's own "/" index route
// (adminOverviewRoute, parented at adminRoute) and would inherit the authed
// shell this redirect exists to route around. /home sits under that shell,
// which itself sends a signed-out visitor on to /login (see AppShell in
// screens/shell.tsx), so redirecting straight to /home is correct in both
// states.
const rootIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/home" });
  },
});

// Operator console — its own layout with a bottom tab bar per concern.
// Lazy chunks; role-guarded in the shell.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyRouteComponent(
    () => import("@/screens/admin/shell"),
    "AdminShell",
  ),
});

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyRouteComponent(
    () => import("@/screens/admin/Overview"),
    "AdminOverview",
  ),
});

const adminFamiliesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/families",
  component: lazyRouteComponent(
    () => import("@/screens/admin/Families"),
    "AdminFamilies",
  ),
});

// The family detail page. A child of adminRoute rather than of
// adminFamiliesRoute: the list and the detail are two screens, not a screen
// with a nested one, and the tab bar highlights Families for both.
const adminFamilyDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/families/$id",
  component: lazyRouteComponent(
    () => import("@/screens/admin/FamilyDetail"),
    "AdminFamilyDetailScreen",
  ),
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/users",
  component: lazyRouteComponent(
    () => import("@/screens/admin/Users"),
    "AdminUsers",
  ),
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/audit",
  component: lazyRouteComponent(
    () => import("@/screens/admin/Audit"),
    "AdminAudit",
  ),
});

// Exported for apps/frontend/test/router.test.ts, which finds rootIndexRoute
// by id and calls its beforeLoad directly to pin the "/" redirect — this
// suite has no DOM, and TanStack Router's client load path needs one.
// The care station (spec: kiosk mode). A sibling of the authed shell, not
// a child: it shares the guards through AuthGate but has no tab bar, no
// rail and no width cap.
const kioskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kiosk",
  component: lazyRouteComponent(() => import("@/screens/Kiosk"), "KioskRoute"),
});

// Enrolling a tablet as the family's kiosk (spec 2026-09-10-kiosk-devices
// §7): outside every gate — the tablet has neither a session nor a device
// yet. ?code= arrives from the Settings QR.
const kioskSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kiosk/setup",
  validateSearch: (search: Record<string, unknown>): { code?: string } =>
    typeof search.code === "string" ? { code: search.code } : {},
  component: KioskSetupRoute,
});

function KioskSetupRoute() {
  const { code } = kioskSetupRoute.useSearch();
  return <KioskSetupScreen initialCode={code} />;
}

export const routeTree = rootRoute.addChildren([
  rootIndexRoute,
  appRoute.addChildren([
    homeRoute,
    timelineRoute,
    calendarRoute,
    statsRoute,
    vaccinesRoute,
    settingsRoute,
    profileRoute,
  ]),
  loginRoute,
  joinRoute,
  welcomeRoute,
  kioskRoute,
  kioskSetupRoute,
  adminRoute.addChildren([
    adminOverviewRoute,
    adminFamiliesRoute,
    adminFamilyDetailRoute,
    adminUsersRoute,
    adminAuditRoute,
  ]),
]);

// Anything that matches no route at all (a stale link, a typo). Minimal on
// purpose — this is a fallback, not a screen — but it must not be TanStack's
// bare default, which names no way back into the app.
function NotFoundScreen() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm text-muted">{t("Page not found")}</p>
      <Link to="/home" className="text-sm font-semibold text-accent">
        {t("Back to Pjokk")}
      </Link>
    </div>
  );
}

export const router = createRouter({
  // A screen that throws while rendering lands here, not on a blank page
  // with a stack trace (see components/ErrorBoundary.tsx).
  defaultErrorComponent: ({ error, reset }) => (
    <AppErrorScreen error={error} reset={reset} />
  ),
  routeTree,
  defaultNotFoundComponent: NotFoundScreen,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
