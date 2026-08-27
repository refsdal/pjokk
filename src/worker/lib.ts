import { OpenAPIHono } from "@hono/zod-openapi";
import type { z } from "@hono/zod-openapi";

export function createApp<E extends { Bindings: Env }>() {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "Invalid request",
            code: "VALIDATION",
            issues: result.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          400,
        );
      }
    },
  });
}

export function jsonContent<T extends z.ZodType>(
  schema: T,
  description: string,
) {
  return { content: { "application/json": { schema } }, description };
}

// Partial unique indexes ("one active session per baby") are the real guard
// against a double-tap or an offline-queue replay. Drizzle wraps the SQLite
// error, so recognizing one means walking the cause chain.
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (String(e).includes("UNIQUE")) return true;
  }
  return false;
}

export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function serFeed<T extends { time: Date }>(row: T) {
  return { ...row, time: iso(row.time) };
}

export function serDiaper<T extends { time: Date }>(row: T) {
  return { ...row, time: iso(row.time) };
}

export function serSleep<T extends { startTime: Date; endTime: Date | null }>(
  row: T,
) {
  return {
    ...row,
    startTime: iso(row.startTime),
    endTime: isoOrNull(row.endTime),
  };
}

export function serBaby(row: {
  id: string;
  name: string;
  birthDate: Date;
  sex: "girl" | "boy" | null;
}) {
  return {
    id: row.id,
    name: row.name,
    birthDate: iso(row.birthDate),
    sex: row.sex,
  };
}
