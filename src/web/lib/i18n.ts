// Every user-facing string goes through t(). Today it's identity; a
// translation layer (English/Norwegian) drops in later without a UI sweep.
export function t(s: string): string {
  return s;
}
