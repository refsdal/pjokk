import { useToasts } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-safe">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "mt-2 rounded-full px-4 py-2 text-sm font-semibold shadow-lg",
            t.kind === "error" ? "bg-danger text-on-accent" : "bg-ink text-bg",
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
