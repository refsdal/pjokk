import { AuthGate } from "@/screens/shell";

// The care station (spec: kiosk mode). Filled in by the next task; this
// cut exists so the route, the guard extraction and the redirect can land
// on their own.
export function KioskRoute() {
  return (
    <AuthGate>
      <KioskScreen />
    </AuthGate>
  );
}

export function KioskScreen() {
  return <div className="min-h-dvh bg-bg text-ink" />;
}
