import { useEffect, useState } from "react";

// "Update available" plumbing: registerSW (main.tsx) pushes the update
// callback here; the banner component consumes it. No silent stale versions.
type UpdateFn = () => void;

let pending: UpdateFn | null = null;
const listeners = new Set<(fn: UpdateFn) => void>();

export function announceUpdate(fn: UpdateFn) {
  pending = fn;
  for (const l of listeners) l(fn);
}

export function useAppUpdate(): UpdateFn | null {
  const [fn, setFn] = useState<UpdateFn | null>(() => pending);
  useEffect(() => {
    const onUpdate = (f: UpdateFn) => setFn(() => f);
    listeners.add(onUpdate);
    return () => {
      listeners.delete(onUpdate);
    };
  }, []);
  return fn;
}
