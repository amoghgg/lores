// Core flows on desktop: home, picking looks, undo, compare, PIXEL tab,
// saving with the recipe inside the PNG, persistence, links, ⌘K, theme.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { enterFresh, look, nowTitle, openFamily, recipe, trackErrors, waitRecipe } from "./helpers";

test("home → app, brand and default look", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await expect(page.locator(".home")).toBeVisible();
  await expect(page).toHaveTitle(/LORES/);
  await page.getByRole("button", { name: /TRY ON CHUCK|CONTINUE/ }).click();
  await expect(page.locator(".bar-logo")).toHaveText("LORES");
  await expect(page.getByRole("tab", { name: "LOOKS" })).toBeVisible();
  expect(await nowTitle(page)).toContain("PORTRA 400");
  // New users land on the curated set, families folded away.
  await expect(page.locator(".chip-on", { hasText: /^BEST$/ })).toBeVisible();
  await expect(page.locator(".chips-families")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("pick, undo/redo, hold to compare", async ({ page }) => {
  const errors = trackErrors(page);
  await enterFresh(page);
  await look(page, "KODACHROME 64").click();
  await expect(page.locator(".now-title")).toContainText("KODACHROME 64");
  await waitRecipe(page, (c) => c.includes("film:kodachrome64"));
  expect(page.url()).not.toContain("#");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".now-title")).toContainText("PORTRA 400");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".now-title")).toContainText("KODACHROME 64");

  const box = (await page.locator(".viewer").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator(".viewer-badge", { hasText: "ORIGINAL" })).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".viewer-badge")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("MORE LOOKS opens the families and BEST folds them", async ({ page }) => {
  await enterFresh(page);
  await openFamily(page, "SLIDE & SCREEN");
  await expect(look(page, "VELVIA 50")).toBeVisible();
  await page.locator(".chip", { hasText: "MORE LOOKS" }).click();
  await expect(page.locator(".chips-families")).toHaveCount(0);
  await expect(page.locator(".chip-on", { hasText: /^BEST$/ })).toBeVisible();
});

test("PIXEL tab, save with recipe, reopen, reload", async ({ page }, info) => {
  const errors = trackErrors(page);
  await enterFresh(page);
  await page.getByRole("tab", { name: "PIXEL" }).click();
  await page.locator(".row", { hasText: "SIZE" }).locator(".thumb", { hasText: "8PX" }).click();
  await page.locator(".row", { hasText: "COLOURS" }).locator(".thumb", { hasText: "PICO-8" }).click();
  await page.locator(".row", { hasText: "PATTERN" }).locator(".thumb", { hasText: "BAYER 4" }).click();
  const code = await waitRecipe(page, (c) => c.includes("px:8") && c.includes("pal:pico8") && c.includes("dt:bayer4"));

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "SAVE", exact: true }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^[^~#]+ \([^)]+\)\.png$/);
  const file = info.outputPath("saved.png");
  await dl.saveAs(file);
  const buf = fs.readFileSync(file);
  expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
  expect(buf.includes(Buffer.from("pixel\0" + code))).toBe(true);

  // Change the look, then reopen the saved PNG: its recipe comes back.
  await page.keyboard.press("Space");
  await waitRecipe(page, (c) => c !== code);
  await page.setInputFiles("input[type=file] >> nth=0", file);
  await waitRecipe(page, (c) => c === code);

  await page.reload();
  await page.getByRole("button", { name: "CONTINUE" }).click();
  expect(await recipe(page)).toBe(code);
  await expect(page.locator(".bar-file")).toContainText("saved");
  expect(errors).toEqual([]);
});

test("shared link applies and cleans; ⌘K; theme persists", async ({ page }) => {
  const errors = trackErrors(page);
  await enterFresh(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("cinestill 8");
  await page.keyboard.press("Enter");
  await expect(page.locator(".now-title")).toContainText("CINESTILL 800T");

  await page.locator('.bar-icon[aria-label^="Switch to"]').click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.goto("/#r=1~film:velvia50.s7");
  await expect.poll(() => page.url()).not.toContain("#");
  await waitRecipe(page, (c) => c.includes("film:velvia50"));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  expect(errors).toEqual([]);
});
