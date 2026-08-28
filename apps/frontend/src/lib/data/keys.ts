import type { QueryClient } from "@tanstack/react-query";

// Blunt-but-right invalidation at family scale: any log mutation refreshes
// every log-derived view. Revisit only if the payloads ever get big.
export const invalidateLogs = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: ["summary"] });
  void qc.invalidateQueries({ queryKey: ["feeds"] });
  void qc.invalidateQueries({ queryKey: ["diapers"] });
  void qc.invalidateQueries({ queryKey: ["sleep"] });
  void qc.invalidateQueries({ queryKey: ["timeline"] });
  void qc.invalidateQueries({ queryKey: ["other"] });
  void qc.invalidateQueries({ queryKey: ["play"] });
  void qc.invalidateQueries({ queryKey: ["vaccines"] });
  void qc.invalidateQueries({ queryKey: ["vaccine-dismissals"] });
  void qc.invalidateQueries({ queryKey: ["stats"] });
};
