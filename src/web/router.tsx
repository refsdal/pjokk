import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router";
import { Toaster } from "@/components/Toaster";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AppearanceProvider } from "@/lib/appearance";
import { HomeScreen } from "@/screens/Home";
import { JoinScreen } from "@/screens/Join";
import { LoginScreen } from "@/screens/Login";
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

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect } = loginRoute.useSearch();
  return <LoginScreen redirectTo={redirect ?? "/"} />;
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

// Public and lazy: readable without an account (a prospective member, or a
// supervisory authority, must be able to reach them), and never part of the
// app-shell bundle.
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: lazyRouteComponent(
    () => import("@/screens/legal/privacy"),
    "PrivacyScreen",
  ),
});

const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: lazyRouteComponent(
    () => import("@/screens/legal/terms"),
    "TermsScreen",
  ),
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

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    homeRoute,
    timelineRoute,
    calendarRoute,
    statsRoute,
    vaccinesRoute,
    settingsRoute,
  ]),
  loginRoute,
  joinRoute,
  welcomeRoute,
  privacyRoute,
  termsRoute,
  adminRoute.addChildren([
    adminOverviewRoute,
    adminFamiliesRoute,
    adminUsersRoute,
    adminAuditRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
