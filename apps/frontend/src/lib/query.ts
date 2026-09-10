import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { del, get, set } from "idb-keyval";
import { clearFence } from "./family-fence";

const DAY = 24 * 3600_000;

// Cached data must outlive reloads: the timeline/home render instantly from
// IndexedDB while the network catches up. Logging while offline pauses the
// mutation; it resumes automatically when the connection returns.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 14 * DAY,
      retry: 1,
    },
  },
});

export const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key: string) => get(key),
    setItem: (key: string, value: unknown) => set(key, value),
    removeItem: (key: string) => del(key),
  },
  key: "pjokk-query-cache",
});

// Identity/routing queries are NEVER persisted: on a cold load they must
// come fresh from the server, not from a disk snapshot. Persisting `me`
// meant a founder who had just created a family could reload into the
// pre-family snapshot (familyId null) and get bounced to /welcome, where a
// second create is refused. Persistence exists for offline-viewable CONTENT
// (timeline, home cards, stats) — those tolerate a stale-then-revalidate
// render; "which family am I in" does not.
const NEVER_PERSIST = new Set(["me", "family", "members", "my-families"]);

// The persisted cache is keyed on the BUILD, not a hand-bumped string: a
// snapshot written by one build is dropped by the next. Stats gained
// required fields in PR #62 and the old snapshot, restored before the
// network answered, crashed the screen on `nights.length` — a shape change
// nobody thought to bump "v2" for. Offline data survives reloads within a
// build, which is the case that matters; after an update the next open is
// online anyway (that is how the update arrived).
const buildVersion =
  typeof __PJOKK_VERSION__ === "string" ? __PJOKK_VERSION__ : "dev";

export const persistOptions = {
  persister,
  maxAge: 14 * DAY,
  buster: `v3-${buildVersion}`,
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { queryKey: readonly unknown[] }) =>
      !NEVER_PERSIST.has(String(query.queryKey[0])),
  },
};

// Runs once the snapshot is restored (main.tsx). The snapshot renders at
// once, but a restored query keeps its original fetch time, so under
// staleTime it counts as fresh and a reload would trust it — hiding another
// caretaker's change, or your own last log (the persister throttles its
// writes), until the 60 s poll. So: resume the mutations queued offline
// FIRST, so the refetch includes them instead of briefly reverting their
// optimistic entries, THEN mark everything stale — active queries refetch
// now, the rest on their next mount. Offline, a queued mutation keeps the
// first step pending until it can run and the refetch waits with it; the
// snapshot stays on screen meanwhile.
export async function afterRestore(qc: QueryClient): Promise<void> {
  await qc.resumePausedMutations();
  await qc.invalidateQueries();
}

// Forget everything, in memory AND on disk. Needed wherever the identity
// behind the cache changes — sign in, sign out, start/stop impersonating —
// because the cache outlives the page: without the persister half, a reload
// would restore the previous account's `me`, family and members straight
// from IndexedDB and render them before the network could correct it.
export async function resetCache(): Promise<void> {
  // The fence describes the cache being dropped; a fresh identity records
  // its own family on the next /api/me.
  clearFence();
  queryClient.clear();
  await persister.removeClient();
}
