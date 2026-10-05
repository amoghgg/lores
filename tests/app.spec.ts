// Core flows on desktop: home, picking looks, undo, compare, PIXEL tab,
// saving with the recipe inside the PNG, persistence, links, ⌘K, theme.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { enterFresh, fingerprint, look, meanDiff, nowTitle, openFamily, recipe, trackErrors, waitForChange, waitRecipe } from "./helpers";

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

test("renders without WebGPU (CPU fallback)", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true }));
  await enterFresh(page);
  await expect(page.locator(".viewer-layer:last-child canvas")).toHaveCount(1);
  const before = await fingerprint(page);
  await look(page, "TRI-X 400").click();
  await waitForChange(page, before, 1.5);
  expect(errors).toEqual([]);
});

test("environment report (GPU)", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (m) => /\[pixel\]/.test(m.text()) && logs.push(m.text().slice(0, 300)));
  await page.goto("/");
  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return "no navigator.gpu";
    const t0 = performance.now();
    const race = <T,>(p: Promise<T>) => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000))]);
    const a = await race(navigator.gpu.requestAdapter());
    if (a === "timeout") return "requestAdapter timed out";
    if (!a) return "no adapter";
    const d = await race(a.requestDevice());
    const info = (a as unknown as { info?: { vendor?: string; architecture?: string; description?: string } }).info;
    return `${d === "timeout" ? "requestDevice timed out" : "device ok"} in ${Math.round(performance.now() - t0)}ms · ${info?.vendor} ${info?.architecture} ${info?.description}`;
  });
  await page.getByRole("button", { name: /TRY ON CHUCK|CONTINUE/ }).click();
  const t0 = Date.now();
  await expect(page.locator(".viewer-layer:last-child canvas")).toHaveCount(1, { timeout: 60_000 });
  console.log(`GPU: ${gpu} · first render ${Date.now() - t0}ms · ${logs.join(" | ") || "no [pixel] logs"}`);
});

test("browsing looks never downloads an AI model; choosing one does", async ({ page }) => {
  const models: string[] = [];
  page.on("request", (r) => {
    if (/\.tflite|vision_wasm|onnx|huggingface/.test(r.url())) models.push(r.url());
  });
  await enterFresh(page);
  for (const fam of ["BEST", "PS2 & PAINT", "SCREENS & MACHINES"]) {
    await openFamily(page, fam);
    await page.locator(".strip").evaluate((e) => e.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(1500);
  }
  expect(models).toEqual([]);
  await expect(page.locator(".thumb-defer").first()).toContainText("TAP TO LOAD");
  // Choosing a tracking look loads its detector, and its tile then renders.
  await look(page, "BLOB TRACK").click();
  await expect.poll(() => models.some((u) => u.includes("efficientdet")), { timeout: 30_000 }).toBe(true);
  await expect(look(page, "BLOB TRACK").locator(".thumb-defer")).toHaveCount(0, { timeout: 30_000 });
});

test("datamosh strength changes how much it moshes", async ({ page }) => {
  await enterFresh(page);
  // Wait for each render to land (slow on CI's software GPU), not a fixed time.
  let prev = await fingerprint(page);
  await look(page, "DATAMOSH").click();
  await page.mouse.move(2, 2);
  await waitForChange(page, prev, 0.05, 90_000);
  const slider = page.locator(".range input").first();
  const set = async (f: number) => {
    prev = await fingerprint(page);
    const b = (await slider.boundingBox())!;
    await page.mouse.click(b.x + b.width * f, b.y + b.height / 2);
    await page.mouse.move(2, 2);
    await waitForChange(page, prev, 0.05, 90_000);
    return fingerprint(page);
  };
  const low = await set(0.15);
  const high = await set(0.99);
  prev = high;
  await look(page, "NONE").click();
  await page.mouse.move(2, 2);
  await waitForChange(page, prev, 0.05, 90_000);
  const none = await fingerprint(page);
  const maxDiff = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
  console.log(`mosh low: mean ${meanDiff(low, none).toFixed(1)} max ${maxDiff(low, none)} · high: mean ${meanDiff(high, none).toFixed(1)}`);
  // Low strength moshes fewer blocks, but those blocks really move — a 15%
  // fade could never shift a pixel this far.
  expect(maxDiff(low, none)).toBeGreaterThan(80);
  expect(meanDiff(high, none)).toBeGreaterThan(meanDiff(low, none) * 1.5);
});
