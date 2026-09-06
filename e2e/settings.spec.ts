import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// The footer's version is the binary's own build version, stamped by
// scripts/build-artifacts.sh from PJOKK_VERSION — the same string the
// preview image is tagged with in CI. The stack under test was built with
// that variable (or not: "dev"), so the footer must say exactly that.
test("settings footer shows the stamped build version", async ({ page, request }) => {
  await freshFamily(page, request, "version");
  await page.goto("/settings");
  const expected = `Pjokk ${process.env.PJOKK_VERSION ?? "dev"}`;
  await expect(page.getByText(expected)).toBeVisible({ timeout: 10_000 });
});
