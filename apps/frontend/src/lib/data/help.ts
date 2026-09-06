import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HelpRequest } from "@pjokk/shared";
import { ApiError, client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";

// Help requests are plain ONLINE mutations, deliberately not registered in
// registerMutationDefaults' offline-resumable set: a ping with no signal
// reaches nobody, and one that fires an hour later when the phone
// reconnects is worse than an error toast now. The summary query carries
// the request back to every screen (openHelp), so success just invalidates
// it.

export type CreateHelpVars = { memberId: string; message?: string };
export type HelpIdVars = { id: string };

const invalidateSummary = (qc: ReturnType<typeof useQueryClient>) =>
  void qc.invalidateQueries({ queryKey: ["summary"] });

export function useCreateHelpRequest() {
  const qc = useQueryClient();
  return useMutation<HelpRequest, Error, CreateHelpVars>({
    mutationFn: async (vars) =>
      unwrap<HelpRequest>(client.POST("/api/help", { body: vars })),
    onSuccess: () => invalidateSummary(qc),
    onError: (err) =>
      toast(
        err instanceof ApiError && err.code === "RATE_LIMITED"
          ? t("Too many requests — wait a few minutes")
          : `${t("Could not send")}: ${err.message}`,
        "error",
      ),
  });
}

export function useAcknowledgeHelpRequest() {
  const qc = useQueryClient();
  return useMutation<HelpRequest, Error, HelpIdVars>({
    mutationFn: async ({ id }) =>
      unwrap<HelpRequest>(
        client.POST("/api/help/{id}/acknowledge", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () => invalidateSummary(qc),
    onError: (err) => toast(`${t("Could not save")}: ${err.message}`, "error"),
  });
}

export function useDeleteHelpRequest() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, HelpIdVars>({
    mutationFn: async ({ id }) =>
      unwrap(client.DELETE("/api/help/{id}", { params: { path: { id } } })),
    onSuccess: () => invalidateSummary(qc),
    onError: (err) => toast(t("Could not delete: ") + err.message, "error"),
  });
}
