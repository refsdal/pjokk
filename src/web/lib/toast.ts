import { useEffect, useState } from "react";

// Minimal toast bus — enough for "saved offline" and error feedback.
type Toast = { id: number; message: string; kind: "info" | "error" };

let nextId = 1;
const listeners = new Set<(t: Toast) => void>();

export function toast(message: string, kind: "info" | "error" = "info") {
  const item = { id: nextId++, message, kind };
  for (const fn of listeners) fn(item);
}

export function useToasts(ttlMs = 3500) {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const onToast = (item: Toast) => {
      setItems((prev) => [...prev, item]);
      setTimeout(
        () => setItems((prev) => prev.filter((x) => x.id !== item.id)),
        ttlMs,
      );
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, [ttlMs]);
  return items;
}
