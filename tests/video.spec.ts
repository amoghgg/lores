// Video: open a clip, play it through a look, save the whole thing.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { enterFresh, fingerprint, look, meanDiff, openFamily, trackErrors, waitForChange } from "./helpers";

const CLIP = path.join(__dirname, "fixtures", "clip.webm");

test("video: open, play through a look, save the clip", async ({ page }, info) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await enterFresh(page);
  await page.setInputFiles("input[type=file] >> nth=0", CLIP);
  await expect(page.locator(".vbar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".bar-save .btn-primary").first()).toHaveText("SAVE VIDEO");

  // Heavy restyles are marked photo-only.
  await openFamily(page, "PS2 & PAINT");
  await expect(look(page, "PS2 RED").locator(".thumb-defer")).toHaveText("PHOTOS ONLY");
  await openFamily(page, "BEST");

  const before = await fingerprint(page);
  await look(page, "TRI-X 400").click();
  await page.mouse.move(2, 2);
  await waitForChange(page, before, 1.5, 90_000);

  // Playing runs frames through the look; the clock moves.
  const still = await fingerprint(page);
  await page.locator(".vbar-play").click();
  await expect.poll(async () => meanDiff(await fingerprint(page), still), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await expect(page.locator(".vbar-time")).not.toHaveText(/^0:00 \//, { timeout: 30_000 });
  await page.locator(".vbar-play").click();

  // Save renders every frame and keeps the audio.
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.locator(".bar-save .btn-primary").first().click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/^clip \(Tri-x 400\)\.(mp4|webm)$/i);
  const file = info.outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  const head = fs.readFileSync(file).subarray(0, 12);
  const isMp4 = head.subarray(4, 8).toString() === "ftyp";
  const isWebm = head.subarray(0, 4).toString("hex") === "1a45dfa3";
  expect(isMp4 || isWebm).toBe(true);
  // Sensible size for 2 s at 360×520 (the bitrate cap works).
  const size = fs.statSync(file).size;
  expect(size).toBeGreaterThan(20_000);
  expect(size).toBeLessThan(3_000_000);
  expect(errors).toEqual([]);
});
