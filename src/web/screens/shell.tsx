import { Navigate, Outlet } from "@tanstack/react-router";
import { createContext, useContext } from "react";
import { TabBar } from "@/components/TabBar";
import { useSession } from "@/lib/auth-client";
import { useNight } from "@/lib/night";

type NightContextValue = ReturnType<typeof useNight>;

const NightContext = createContext<NightContextValue | null>(null);

export function useNightContext(): NightContextValue {
  const ctx = useContext(NightContext);
  if (!ctx) throw new Error("useNightContext outside AppShell");
  return ctx;
}

// Authed shell: session required; users without a family go to /welcome
// (the invite flow normally prevents that, but the family founder starts
// here). Night mode is owned here so every tab inherits it.
export function AppShell() {
  const { data: session, isPending } = useSession();
  const nightValue = useNight();

  if (isPending) {
    return <div className="min-h-dvh" />;
  }
  if (!session) {
    return <Navigate to="/login" />;
  }
  if (!session.session.activeOrganizationId) {
    return <Navigate to="/welcome" />;
  }

  return (
    <NightContext.Provider value={nightValue}>
      <div className="min-h-dvh">
        <Outlet />
        <TabBar />
      </div>
    </NightContext.Provider>
  );
}
