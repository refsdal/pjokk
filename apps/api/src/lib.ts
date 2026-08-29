import { OpenAPIHono } from "@hono/zod-openapi";
import type { z } from "@hono/zod-openapi";

// Nothing arrives through Hono's env any more (see context.ts), so every
// AppEnv/FamEnv carries an empty Bindings — this is just the shape
// createApp's generic parameter needs to see.
export function createApp<E extends { Bindings: Record<string, never> }>() {
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
// against a double-tap or an offline-queue replay. Drizzle wraps the driver
// error, so recognizing one means walking the cause chain.
//
// 23505 is the SQL standard's unique_violation SQLSTATE, which Bun's Postgres
// driver surfaces as `errno`. Matching the code rather than the message is
// what makes this robust: the previous implementation looked for the literal
// "UNIQUE" in the text, which is SQLite's wording — Postgres says "duplicate
// key value violates unique constraint", so a text match silently stopped
// working and turned every "already active" conflict into a 500.
const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const candidate = e as { errno?: unknown; code?: unknown };
    if (candidate.errno === UNIQUE_VIOLATION) return true;
    if (candidate.code === UNIQUE_VIOLATION) return true;
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
