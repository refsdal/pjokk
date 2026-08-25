import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { AdminFamilySchema } from "@shared/schemas";
import { DeleteButton } from "@/components/DeleteButton";
import { Card } from "@/components/ui/card";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";

type AdminFamily = z.infer<typeof AdminFamilySchema>;

export function AdminFamilies() {
  const queryClient = useQueryClient();
  const families = useQuery({
    queryKey: ["admin", "families"],
    queryFn: async () => unwrap<AdminFamily[]>(await api.admin.families.$get()),
  });

  const deleteFamily = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.admin.families[":id"].$delete({ param: { id } })),
    onSuccess: () => {
      toast("Family deleted");
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
