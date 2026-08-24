import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { API_BASE } from "./api";

export const authClient = createAuthClient({
  ...(API_BASE ? { baseURL: API_BASE } : {}),
  plugins: [organizationClient()],
});

export const { useSession, signIn, signOut } = authClient;
