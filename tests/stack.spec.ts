// Stacking looks: ＋ adds a layer, tap swaps the selected one, the layer
// bar shows the real engine order, and the text switch covers every layer.
import { test, expect } from "@playwright/test";
import { enterFresh, fingerprint, look, meanDiff, openFamily, trackErrors, waitForChange, waitRecipe } from "./helpers";

const count = (c: string) => (c.match(/film:/g) ?? []).length;

test("＋ stacks, tap swaps, × removes, undo restores", async ({ page }) => {
  const errors = trackErrors(page);
  await enterFresh(page);
  const before = await fingerprint(page);

  await look(page, "KODACHROME 64").locator(".thumb-plus").click();
  await waitRecipe(page, (c) => c.includes("film:portra400") && c.includes("film:kodachrome64"));
  await expect(page.locator(".now-title")).toContainText("2. KODACHROME 64");
  await expect(page.locator(".layer", { hasText: "LOOK 2" })).toBeVisible();
  await waitForChange(page, before, 1);

  await look(page, "CINESTILL 800T").locator(".thumb-plus").click();
  await waitRecipe(page, (c) => count(c) === 3);
  // Tapping a look swaps the selected (third) layer.
  await look(page, "TRI-X 400").click();
  const swapped = await waitRecipe(page, (c) => c.includes("film:trix") && !c.includes("cinestill800t"));
  expect(count(swapped)).toBe(3);

  await page.locator(".layer", { hasText: "LOOK 1" }).locator(".layer-main").click();
  await expect(page.locator(".now-title")).toContainText("1. PORTRA 400");

  await page.locator(".layer", { hasText: "LOOK 2" }).locator(".layer-x").click();
  await waitRecipe(page, (c) => !c.includes("kodachrome64") && count(c) === 2);
  await page.keyboard.press("ControlOrMeta+z");
  await waitRecipe(page, (c) => c.includes("kodachrome64"));

  await page.reload();
  await page.getByRole("button", { name: /CONTINUE|TRY ON CHUCK/ }).click();
  await expect(page.locator(".layer", { hasText: "LOOK 3" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the layer bar follows the real order", async ({ page }) => {
  await enterFresh(page);
  // Portra is on. Add a screen (CRT) and a restyle (datamosh) — however they
  // were added, the bar reads restyle → grade → screen.
  await look(page, "CRT TRINITRON").locator(".thumb-plus").click();
  await look(page, "DATAMOSH").locator(".thumb-plus").click();
  await waitRecipe(page, (c) => count(c) === 3);
  const chips = await page.locator(".layer .layer-main").allInnerTexts();
  const order = chips.map((t) => t.replace(/\s+/g, " "));
  expect(order[0]).toContain("DATAMOSH");
  expect(order[1]).toContain("PORTRA 400");
  expect(order[2]).toContain("CRT TRINITRON");
  // The selected layer follows the look you just added.
  await expect(page.locator(".now-title")).toContainText("DATAMOSH");
});

test("one text switch removes writing from every layer", async ({ page }) => {
  const errors = trackErrors(page);
  await enterFresh(page);
  await expect(page.locator(".now-tick")).toHaveCount(0); // Portra writes nothing
  await openFamily(page, "AFTERDARK");
  await look(page, "NIGHTSHOT").click();
  await look(page, "NIGHTSHOT").locator(".thumb-plus").click();
  await waitRecipe(page, (c) => count(c) === 2);
  await expect(page.locator(".now-tick")).toContainText("NIGHTSHOT");

  const corner = () =>
    page.evaluate(() => {
      const c = document.querySelector(".viewer-layer:last-child canvas") as HTMLCanvasElement;
      const t = document.createElement("canvas");
      t.width = 40;
      t.height = 40;
      t.getContext("2d")!.drawImage(c, c.width * 0.6, 0, c.width * 0.4, c.height * 0.12, 0, 0, 40, 40);
      return Array.from(t.getContext("2d")!.getImageData(0, 0, 40, 40).data);
    });
  const withText = await corner();
  await page.locator(".now-tick input").click();
  await waitRecipe(page, (c) => c.includes("notext"));
  await expect.poll(async () => meanDiff(await corner(), withText)).toBeGreaterThan(2);
  await page.locator(".layer", { hasText: "LOOK 1" }).locator(".layer-main").click();
  await expect(page.locator(".now-tick input")).not.toBeChecked();
  expect(errors).toEqual([]);
});
