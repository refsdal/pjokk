import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { del, get, set } from "idb-keyval";

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

export const persistOptions = {
  persister,
  maxAge: 14 * DAY,
  buster: "v1",
};

// Forget everything, in memory AND on disk. Needed wherever the identity
// behind the cache changes — sign in, sign out, start/stop impersonating —
// because the cache outlives the page: without the persister half, a reload
// would restore the previous account's `me`, family and members straight
// from IndexedDB and render them before the network could correct it.
export async function resetCache(): Promise<void> {
  queryClient.clear();
  await persister.removeClient();
}
