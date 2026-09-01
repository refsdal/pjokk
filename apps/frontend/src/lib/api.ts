import createClient from "openapi-fetch";
import type { paths } from "./api-schema";

// '' = same origin (the container serves both SPA and API). A future native
// shell points this at the deployed origin instead.
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export const client = createClient<paths>({
  baseUrl: API_BASE,
  credentials: "include",
});

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// openapi-fetch resolves every call to { data, error, response } rather than
// throwing — unwrap adapts that back to the throw-ApiError-on-error shape
// every call site (and every onError handler checking `err.code`) already
// expects. Takes the client.GET/POST/… call directly (unawaited) so call
// sites read `unwrap(client.GET(...))`, same shape as the old
// `unwrap(await api.foo.$get())`.
//
// `data`/`error` are deliberately typed `unknown` here rather than tied to
// T: every call site names T explicitly (matching the old hono-client
// call sites, which all did `unwrap<Foo>(...)` too), and `data as T` below
// is the same trust-the-server cast the old unwrap always did. Trying to
// have TypeScript INFER T from the openapi-fetch result instead (`data?:
// T`) does not work — T comes back uninferrable (silently `{}}`) through
// the Promise-wrapped, two-branch-union shape openapi-fetch returns, and
// tying the parameter's `data` field to T instead makes the reverse case
// (asserting an explicit T that intentionally differs from the generated
// schema's open TimelineEntry shape, e.g. useTimeline) fail as a straight
// assignability error. `unknown` on the parameter sidesteps both.
//
// A couple of call sites (the vaccine-document multipart upload and delete
// — see lib/data/vaccines.ts) bypass the generated client entirely and
// hand unwrap an (awaited) raw fetch() Response instead, since those two
// routes are deliberately excluded from the OpenAPI spec
// (internal/api/files.go); this overload keeps their old ResponseLike
// semantics working unchanged.
interface OpenApiFetchResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

export async function unwrap<T = unknown>(
  result:
    | OpenApiFetchResult
    | Response
    | Promise<OpenApiFetchResult | Response>,
): Promise<T> {
  result = await result;
  if (result instanceof Response) {
    if (!result.ok) {
      let message = result.statusText;
      let code: string | undefined;
      try {
        const body = (await result.json()) as {
          error?: string;
          code?: string;
        };
        message = body.error ?? message;
        code = body.code;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(result.status, message, code);
    }
    return (await result.json()) as T;
  }

  const { data, error, response } = result;
  if (error !== undefined) {
    const body = error as { error?: string; code?: string } | undefined;
    throw new ApiError(
      response.status,
      body?.error ?? response.statusText,
      body?.code,
    );
  }
  return data as T;
}
