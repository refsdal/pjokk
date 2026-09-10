import { afterEach, describe, expect, test } from "bun:test";
import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterRestore } from "../src/lib/query";

// What runs once the IndexedDB snapshot is restored (main.tsx). A restored
// query keeps its original fetch time, so under the app's staleTime it
// counts as fresh and mounting alone never refetches it — which is how a
// reload used to hide another caretaker's change, or your own last log,
// until the 60 s poll.

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for condition");
}

afterEach(() => onlineManager.setOnline(true));

describe("afterRestore", () => {
  test("a restored query is revalidated, not trusted as fresh", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["summary", "b1"], "snapshot");
    let fetches = 0;
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["summary", "b1"],
      queryFn: async () => {
        fetches++;
        return "server";
      },
      staleTime: 15_000,
    }).subscribe(() => {});
    // The bug, pinned: fresh by staleTime, so mounting does not fetch.
    expect(fetches).toBe(0);

    await afterRestore(qc);
    await waitFor(() => qc.getQueryData(["summary", "b1"]) === "server");
    expect(fetches).toBe(1);
    unsubscribe();
  });

  test("mutations queued offline run before the refetch", async () => {
    const qc = new QueryClient();
    const order: string[] = [];
    qc.setQueryData(["summary", "b1"], 0);
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["summary", "b1"],
      queryFn: async () => {
        order.push("refetch");
        return 1;
      },
      staleTime: 15_000,
    }).subscribe(() => {});

    // A log made with no signal: the mutation pauses. The client is never
    // mounted here, so coming back online does not resume it by itself.
    onlineManager.setOnline(false);
    void qc
      .getMutationCache()
      .build(qc, {
        mutationFn: async () => {
          order.push("mutation");
        },
      })
      .execute(undefined);
    await waitFor(
      () => qc.getMutationCache().getAll()[0]?.state.isPaused === true,
    );
    onlineManager.setOnline(true);

    await afterRestore(qc);
    await waitFor(() => order.includes("refetch"));
    // Refetching first would briefly show the server state from before the
    // queued write, reverting its optimistic entry under the user.
    expect(order).toEqual(["mutation", "refetch"]);
    unsubscribe();
  });
});
