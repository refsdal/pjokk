import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../api";

// Reminders (issue #45): the caller's own list in the active family. Plain
// mutations, not the offline-resumable kind — this is Settings, and a nag
// configured with no signal can wait for the signal.

export type ReminderKind = "feed" | "diaper" | "pump" | "medicine" | "custom";
export type ReminderMode = "since_last" | "at_time";

export interface Reminder {
  id: string;
  babyId: string | null;
  kind: ReminderKind;
  mode: ReminderMode;
  intervalMin: number | null;
  atMinute: number | null;
  days: number;
  tz: string;
  quietStart: number | null;
  quietEnd: number | null;
  label: string | null;
  lastFiredAt: string | null;
}

export interface CreateReminderVars {
  babyId?: string;
  kind: ReminderKind;
  mode: ReminderMode;
  intervalMin?: number;
  atMinute?: number;
  days: number;
  tz: string;
  quietStart?: number;
  quietEnd?: number;
  label?: string;
}

const KEY = ["reminders"];

export function useReminders() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => unwrap<Reminder[]>(client.GET("/api/reminders")),
  });
}

export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation<Reminder, Error, CreateReminderVars>({
    mutationFn: async (body) =>
      unwrap<Reminder>(client.POST("/api/reminders", { body })),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteReminder() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (id) =>
      unwrap(
        client.DELETE("/api/reminders/{id}", { params: { path: { id } } }),
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
