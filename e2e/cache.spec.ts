import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The persisted query cache (apps/frontend/src/lib/query.ts) against the
// real artifact: a reload renders the IndexedDB snapshot at once and then
// revalidates it, rather than trusting it as fresh for staleTime (15 s).
// The write below comes from outside the page — another caretaker's phone —
// so only a refetch can bring it in.
test("a reload revalidates the restored cache instead of trusting it", async ({
  page,
  request,
}) => {
  await freshFamily(page, request, "cache-revalidate");
  await expect(page.getByText(/^0 wet · /)).toBeVisible({ timeout: 10_000 });
  // Let the persister write the snapshot: it throttles writes to one a second.
  await page.waitForTimeout(1_500);

  const babies = await (await page.request.get("/api/babies")).json();
  const res = await page.request.post("/api/diapers", {
    data: { babyId: babies[0].id, time: new Date().toISOString(), type: "wet" },
  });
  expect(res.status(), await res.text()).toBe(201);

  await page.reload();
  // Well inside staleTime and the 60 s poll: only the revalidation after
  // restore can show the new diaper this soon.
  await expect(page.getByText(/^1 wet · /)).toBeVisible({ timeout: 5_000 });
});
