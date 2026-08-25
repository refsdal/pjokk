import { createAuthClient } from "better-auth/react";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import { API_BASE } from "./api";

export const authClient = createAuthClient({
  ...(API_BASE ? { baseURL: API_BASE } : {}),
  plugins: [organizationClient(), adminClient()],
});

export const { useSession, signIn, signOut } = authClient;

// The admin plugin's role doesn't flow through better-auth's session type
// inference — this is the ONE sanctioned cast for it.
export function isSysadmin(
  session: { user: unknown } | null | undefined,
): boolean {
  return (
    (session?.user as { role?: string | null } | undefined)?.role === "admin"
  );
}
