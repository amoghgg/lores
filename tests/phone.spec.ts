// Phone layout: nothing overflows sideways, looks are tappable, stacking
// and the layer bar work with touch.
import { test, expect } from "@playwright/test";
import { enterFresh, look, trackErrors, waitRecipe } from "./helpers";

test("phone: home, pick a look, stack, no sideways scroll", async ({ page }) => {
  const errors = trackErrors(page);
  await enterFresh(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);

  await look(page, "KODACHROME 64").click();
  await waitRecipe(page, (c) => c.includes("kodachrome64"));
  await look(page, "TRI-X 400").locator(".thumb-plus").click();
  await waitRecipe(page, (c) => c.includes("kodachrome64") && c.includes("trix"));
  await expect(page.locator(".layer", { hasText: "LOOK 2" })).toBeVisible();
  await page.locator(".chip", { hasText: "MORE LOOKS" }).click();
  await expect(page.locator(".chips-families")).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
