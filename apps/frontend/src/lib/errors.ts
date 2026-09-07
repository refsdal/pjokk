// What the error screen shows for an unknown thrown value (lib/errors.ts
// is tiny on purpose: the boundary must not itself have anything to throw).
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    // JSON.stringify(undefined) is undefined, not a string.
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
