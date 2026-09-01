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
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";

// Calendar mutations are plain (no offline mutation-defaults queue): planning
// is a deliberate, online act — unlike 3am logging. See DECISIONS.md.

const invalidateCalendar = (qc: QueryClient) =>
  void qc.invalidateQueries({ queryKey: ["calendar"] });

function toastCalendarError(err: Error) {
  toast(t("Could not save: ") + err.message, "error");
}

export function useCalendarEvents(from: Date, to: Date) {
  return useQuery({
    queryKey: ["calendar", from.getTime(), to.getTime()],
    queryFn: async () =>
      unwrap<CalendarEvent[]>(
        client.GET("/api/calendar/events", {
          params: {
            query: { from: from.toISOString(), to: to.toISOString() },
          },
        }),
      ),
  });
}

export function useCreateCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateCalendarEvent) =>
      unwrap<CalendarEvent>(client.POST("/api/calendar/events", { body })),
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
        client.PATCH("/api/calendar/events/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: toastCalendarError,
    onSettled: () => invalidateCalendar(qc),
  });
}

export function useDeleteCalendarEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) =>
      unwrap(
        client.DELETE("/api/calendar/events/{id}", {
          params: { path: { id } },
        }),
      ),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateCalendar(qc),
  });
}
