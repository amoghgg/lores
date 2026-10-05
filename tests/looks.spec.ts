// Every look in the catalogue renders: tap it on the sample photo, the image
// changes, nothing throws. One test per family so they run in parallel.
import { test, expect } from "@playwright/test";
import { FILM_CATEGORIES, FILM_STOCKS } from "../lib/filmStocks";
import { enterFresh, fingerprint, look, meanDiff, openFamily, trackErrors, waitForChange } from "./helpers";

// Overlays that leave most pixels alone (thin boxes, a soft haze) move the
// fingerprint less; everything else must change the picture clearly.
const SUBTLE = new Set(["blobtrack", "provia", "portra160", "shore", "nordic"]);

for (const fam of FILM_CATEGORIES) {
  test(`every ${fam.label} look renders`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackErrors(page);
    await enterFresh(page);
    await openFamily(page, fam.label);
    await look(page, "NONE").click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1500);
    const base = await fingerprint(page);
    let prev = base;
    for (const s of FILM_STOCKS.filter((x) => x.category === fam.id)) {
      await look(page, s.name).click();
      await page.mouse.move(2, 2);
      await expect(page.locator(".now-title")).toContainText(s.name);
      // It must actually re-render (differ from the look before it)…
      await waitForChange(page, prev, 0.05, 90_000);
      prev = await fingerprint(page);
      // …and clearly differ from the untouched photo.
      expect(meanDiff(await fingerprint(page), base), `${s.name} looks unchanged`).toBeGreaterThan(SUBTLE.has(s.id) ? 0.3 : 1.5);
    }
    expect(errors).toEqual([]);
  });
}
