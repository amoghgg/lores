// CAMERAS splits by maker; FUJIFILM's simulations come from measured colour
// tables that load only when used, and the GPU and CPU engines agree on them.
import { test, expect, type Browser } from "@playwright/test";
import { enterFresh, fingerprint, look, meanDiff, openFamily, trackErrors, waitForChange } from "./helpers";

/** The photo under a look, rendered by the GPU or (navigator.gpu hidden) the CPU. */
async function render(browser: Browser, engine: "gpu" | "cpu", fam: string, name: string) {
  const page = await browser.newPage();
  if (engine === "cpu") await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true }));
  await enterFresh(page);
  await openFamily(page, fam);
  const before = await fingerprint(page);
  await look(page, name).click();
  await page.mouse.move(2, 2);
  await waitForChange(page, before, 1, 90_000);
  const fp = await fingerprint(page);
  await page.close();
  return fp;
}

test("CAMERAS opens on FUJIFILM; makers switch the looks", async ({ page }) => {
  const errors = trackErrors(page);
  const tables: string[] = [];
  page.on("request", (r) => r.url().includes("/luts/") && tables.push(r.url()));
  await enterFresh(page);
  await openFamily(page, "CAMERAS");
  await expect(page.locator(".chips-brands .chip-on")).toHaveText("FUJIFILM");
  for (const name of ["CLASSIC CHROME", "CLASSIC NEG.", "NOSTALGIC NEG.", "ETERNA / CINEMA", "ACROS", "INSTAX MINI"])
    await expect(look(page, name)).toBeVisible();
  await expect(look(page, "HOLGA 120")).toHaveCount(0);
  await page.locator(".chips-brands .chip", { hasText: "TOY & INSTANT" }).click();
  await expect(look(page, "HOLGA 120")).toBeVisible();
  await expect(look(page, "CLASSIC CHROME")).toHaveCount(0);
  // Only the FUJIFILM tiles that were shown fetched tables, each once.
  expect(new Set(tables).size).toBe(tables.length);
  expect(errors).toEqual([]);
});

test("Classic Chrome renders the same on GPU and CPU", async ({ browser }) => {
  // The two engines already differ slightly on the untouched photo
  // (resampling); the colour table must not add to that.
  const base = meanDiff(await render(browser, "gpu", "BEST", "NONE"), await render(browser, "cpu", "BEST", "NONE"));
  const cc = meanDiff(await render(browser, "gpu", "CAMERAS", "CLASSIC CHROME"), await render(browser, "cpu", "CAMERAS", "CLASSIC CHROME"));
  console.log(`GPU vs CPU: untouched ${base.toFixed(2)} · classic chrome ${cc.toFixed(2)}`);
  expect(cc).toBeLessThan(base + 1.5);
});
