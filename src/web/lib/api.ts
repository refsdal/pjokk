import { hc } from "hono/client";
import type { AppType } from "../../worker/index";

// '' = same origin (the Worker serves both SPA and API). A future native
// shell points this at the deployed origin instead.
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export const client = hc<AppType>(API_BASE, {
  init: { credentials: "include" },
});

export const api = client.api;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

export async function unwrap<T>(res: ResponseLike): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      message = body.error ?? message;
      code = body.code;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message, code);
  }
  return (await res.json()) as T;
}
