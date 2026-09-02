import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../api";

// Public, static-ish config: which account-creation paths to offer (/login,
// /join). The OpenAPI spec (openapi/pjokk.yaml `/api/config`) defines this as
// an inline response schema rather than a named component — there is no
// `components["schemas"]["Config"]` to reference — so the result is typed
// explicitly here rather than pulled off the generated schema, matching how
// `operations["getConfig"]` itself is shaped. Not routing-critical the way
// `me` is, so an ordinary cached query is fine.
export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: async () =>
      unwrap<{ openSignup: boolean; oauthProviders: string[] }>(
        client.GET("/api/config"),
      ),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
