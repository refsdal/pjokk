import { api } from "@/lib/api";

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
};

// Notes a better-auth admin op into the audit trail (fire-and-forget).
export function note(action: string, target: string, detail?: string) {
  void api.admin.audit.$post({ json: { action, target, detail } });
}
