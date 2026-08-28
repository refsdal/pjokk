import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  CalendarEvent,
  CreateCalendarEvent,
  UpdateCalendarEvent,
} from "@pjokk/shared";
import { api, ApiError, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";

// Calendar mutations are plain (no offline mutation-defaults queue): planning
// is a deliberate, online act — unlike 3am logging. See DECISIONS.md.

const invalidateCalendar = (qc: QueryClient) =>
  void qc.invalidateQueries({ queryKey: ["calendar"] });

function toastCalendarError(err: Error) {
  if (err instanceof ApiError && err.code === "PLAN_REQUIRED") {
    toast(t("Premium feature — upgrade in Settings"), "error");
    return;
  }
  toast(t("Could not save: ") + err.message, "error");
}

export function useCalendarEvents(from: Date, to: Date) {
  return useQuery({
    queryKey: ["calendar", from.getTime(), to.getTime()],
    queryFn: async () =>
      unwrap<CalendarEvent[]>(
        await api.calendar.events.$get({
          query: { from: from.toISOString(), to: to.toISOString() },
        }),
      ),
  });
}

export function useCreateCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateCalendarEvent) =>
      unwrap<CalendarEvent>(await api.calendar.events.$post({ json: body })),
    onError: toastCalendarError,
    onSettled: () => invalidateCalendar(qc),
  });
}

export function useUpdateCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: UpdateCalendarEvent;
    }) =>
      unwrap<CalendarEvent>(
        await api.calendar.events[":id"].$patch({ param: { id }, json: patch }),
      ),
    onError: toastCalendarError,
    onSettled: () => invalidateCalendar(qc),
  });
}

export function useDeleteCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) =>
      unwrap(await api.calendar.events[":id"].$delete({ param: { id } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateCalendar(qc),
  });
}
