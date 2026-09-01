import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DeleteButton } from "@/components/DeleteButton";
import { Card } from "@/components/ui/card";
import { client, unwrap } from "@/lib/api";
import type { components } from "@/lib/api-schema";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";

type AdminFamily = components["schemas"]["AdminFamily"];

export function AdminFamilies() {
  const queryClient = useQueryClient();
  const families = useQuery({
    queryKey: ["admin", "families"],
    queryFn: async () =>
      unwrap<AdminFamily[]>(client.GET("/api/admin/families")),
  });

  const deleteFamily = useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        client.DELETE("/api/admin/families/{id}", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () => {
      toast("Family deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  // NOTE (Task 25): the Go backend has no plan-set endpoint any more —
  // "Billing is gone" (internal/api/admin.go's package doc comment). This
  // mutation and the comp/revoke buttons below are dead against the new
  // backend and are Task 27's to remove (REF §A8 lists admin/Families.tsx
  // under "simplify plan-conditioned rendering"). Left as a pre-existing
  // compile error on purpose rather than invented against a route that
  // doesn't exist.
  const setPlan = useMutation({
    mutationFn: async (vars: { id: string; plan: "free" | "comp" }) =>
      unwrap(
        // `api` (the old hono client) is intentionally gone — see the NOTE
        // above. Left as a genuine compile error for Task 27 to remove
        // along with the rest of this mutation; not converted because
        // there is no matching Go route.
        await api.admin.families[":id"].plan.$post({
          param: { id: vars.id },
          json: { plan: vars.plan },
        }),
      ),
    onSuccess: () => {
      toast("Plan updated");
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Card className="divide-y divide-line p-0">
      {(families.data ?? []).map((f) => (
        <div key={f.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">
              {f.name}
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted uppercase">
                {f.plan}
              </span>
            </p>
            <p className="text-xs text-muted">
              {f.members} members · {f.babies} babies ·{" "}
              {f.lastFeedAt
                ? `last feed ${formatRelative(new Date(f.lastFeedAt))}`
                : "no feeds"}
            </p>
          </div>
          {f.plan === "comp" ? (
            <button
              type="button"
              className="text-xs font-semibold text-muted underline"
              onClick={() => setPlan.mutate({ id: f.id, plan: "free" })}
            >
              Revoke comp
            </button>
          ) : f.plan === "free" ? (
            <button
              type="button"
              className="text-xs font-semibold text-muted underline"
              onClick={() => setPlan.mutate({ id: f.id, plan: "comp" })}
            >
              Comp
            </button>
          ) : null}
          <div className="w-28 shrink-0">
            <DeleteButton onDelete={() => deleteFamily.mutate(f.id)} />
          </div>
        </div>
      ))}
      {families.isSuccess && families.data.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-muted">
          No families yet.
        </p>
      )}
    </Card>
  );
}
