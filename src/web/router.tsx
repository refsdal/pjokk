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
import { SettingsScreen } from "@/screens/Settings";
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

// Operator console — lazy, role-guarded inside the component.
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyRouteComponent(() => import("@/screens/Admin"), "AdminScreen"),
});

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([homeRoute, timelineRoute, statsRoute, settingsRoute]),
  loginRoute,
  joinRoute,
  welcomeRoute,
  adminRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
