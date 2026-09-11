import { useQuery } from "@tanstack/react-query";
import type { AdminOps } from "@/lib/admin-ops";
import { client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";

// The health read behind both the Ops tab and Overview's status line
// (spec 2026-09-11-admin-ops §2). While a job runs it refetches every 10 s
// so the run is seen to finish; otherwise on focus, like every other query.
export function useAdminOps() {
  return useQuery({
    queryKey: ["admin", "ops"],
    queryFn: async () => unwrap<AdminOps>(client.GET("/api/admin/ops")),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.running) ? 10_000 : false,
  });
}

export function jobTitle(name: string): string {
  if (name === "nightly") return t("Nightly");
  if (name === "frequent") return t("Frequent");
  return name;
}
