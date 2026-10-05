import { expect, type Page } from "@playwright/test";

/** Console noise that isn't a failure (MediaPipe logs its delegate at error level). */
const BENIGN = /TensorFlow Lite|XNNPACK/;

/** Collect real page errors; assert none at the end with `expect(errors).toEqual([])`. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !BENIGN.test(m.text())) errors.push(m.text().slice(0, 300));
  });
  return errors;
}

/** Fresh visit (no saved state), through the home screen into the app. */
export async function enterFresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase("pixel");
  });
  await page.goto("/");
  await page.getByRole("button", { name: /TRY ON CHUCK|CONTINUE/ }).click();
  await expect(page.locator(".home")).toHaveCount(0);
  await expect(page.locator(".now-title")).toBeVisible();
}

/** The current look as its recipe code (what the app remembers). */
export const recipe = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("pixel:recipe") || '""') as string);

/** Wait until the remembered recipe satisfies `ok`. */
export async function waitRecipe(page: Page, ok: (code: string) => boolean) {
  await expect.poll(() => recipe(page).then(ok), { timeout: 15_000 }).toBe(true);
  return recipe(page);
}

export const nowTitle = (page: Page) => page.locator(".now-title").innerText();

/** 32×32 RGBA fingerprint of the main canvas. */
export const fingerprint = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector(".viewer-layer:last-child canvas") as HTMLCanvasElement;
    const t = document.createElement("canvas");
    t.width = 32;
    t.height = 32;
    t.getContext("2d")!.drawImage(c, 0, 0, 32, 32);
    return Array.from(t.getContext("2d")!.getImageData(0, 0, 32, 32).data);
  });

export const meanDiff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

/** Wait for the main canvas to differ from `base` by at least `min`, then settle. */
export async function waitForChange(page: Page, base: number[], min = 1, timeout = 60_000) {
  await expect.poll(async () => meanDiff(await fingerprint(page), base), { timeout, intervals: [500] }).toBeGreaterThan(min);
  // Let any trailing render land.
  let prev = JSON.stringify(await fingerprint(page));
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(400);
    const cur = JSON.stringify(await fingerprint(page));
    if (cur === prev) break;
    prev = cur;
  }
}

/** Open a look family (or BEST) in the LOOKS tab. */
export async function openFamily(page: Page, label: string) {
  if (label === "BEST") return page.locator(".chip", { hasText: /^BEST$/ }).click();
  const fam = page.locator(".chips-families");
  if (!(await fam.isVisible())) await page.locator(".chip", { hasText: "MORE LOOKS" }).click();
  await page.locator(".chips-families .chip", { hasText: label }).click();
}

export const look = (page: Page, name: string) => page.locator(".strip .thumb", { hasText: name }).first();
