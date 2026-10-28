// Video: open a clip, play it through a look, save the whole thing.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { enterFresh, fingerprint, look, meanDiff, openFamily, trackErrors, waitForChange } from "./helpers";

const CLIP = path.join(__dirname, "fixtures", "clip.webm");

test("video: open, play through a look, save the clip", async ({ page }, info) => {
  test.setTimeout(420_000);
  const errors = trackErrors(page);
  await enterFresh(page);
  await page.setInputFiles("input[type=file] >> nth=0", CLIP);
  await expect(page.locator(".vdock")).toBeVisible({ timeout: 30_000 });
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
  await page.locator(".vdock-play").click();
  await expect.poll(async () => meanDiff(await fingerprint(page), still), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await expect(page.locator(".vdock-time")).not.toHaveText(/^0:00 \//, { timeout: 30_000 });
  await page.locator(".vdock-play").click();

  // Save renders every frame and keeps the audio. Surface the app's own log
  // and fail fast if it reports an error instead of waiting out the timeout.
  page.on("console", (m) => /\[pixel\]/.test(m.text()) && console.log("app:", m.text().slice(0, 400)));
  const failed = page
    .locator(".toast", { hasText: "COULDN'T" })
    .waitFor({ timeout: 300_000 })
    .then(async () => {
      throw new Error("export reported: " + (await page.locator(".toast").innerText()));
    });
  const dl = await Promise.race([
    page.waitForEvent("download", { timeout: 300_000 }),
    failed,
    page.locator(".bar-save .btn-primary").first().click().then(() => new Promise<never>(() => {})),
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

test("video: if H.264 is refused at encode time, it saves WebM instead", async ({ page }, info) => {
  test.setTimeout(420_000);
  // Reproduce what CI's Linux Chromium did: the capability check says yes,
  // then the encoder refuses the H.264 configuration when it starts.
  await page.addInitScript(() => {
    const configure = VideoEncoder.prototype.configure;
    VideoEncoder.prototype.configure = function (config: VideoEncoderConfig) {
      if (config.codec.startsWith("avc1")) throw new DOMException("refused for this test", "NotSupportedError");
      return configure.call(this, config);
    };
  });
  await enterFresh(page);
  await page.setInputFiles("input[type=file] >> nth=0", CLIP);
  await expect(page.locator(".vdock")).toBeVisible({ timeout: 30_000 });
  await look(page, "CRT TRINITRON").click();
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 300_000 }),
    page.locator(".bar-save .btn-primary").first().click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.webm$/);
  const file = info.outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  expect(fs.readFileSync(file).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
});

test("video: trim, crop and size shape the saved clip", async ({ page }, info) => {
  test.setTimeout(420_000);
  const errors = trackErrors(page);
  await enterFresh(page);
  await page.setInputFiles("input[type=file] >> nth=0", CLIP);
  await expect(page.locator(".vdock")).toBeVisible({ timeout: 30_000 });
  // The filmstrip fills in under the timeline.
  await expect(page.locator(".vdock-thumb").first()).toBeAttached({ timeout: 30_000 });

  // Trim to roughly the middle half by dragging both handles.
  const track = (await page.locator(".vdock-track").boundingBox())!;
  const y = track.y + track.height / 2;
  const drag = async (sel: string, toFrac: number) => {
    const h = (await page.locator(sel).boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * toFrac, y, { steps: 6 });
    await page.mouse.up();
  };
  await drag(".vdock-handle-start", 0.25);
  await drag(".vdock-handle-end", 0.75);
  await expect(page.locator(".vdock-out")).toContainText("TRIMMED");

  // Square crop, framed and confirmed; 720p.
  await page.locator(".vdock-chips .chip", { hasText: "1:1" }).click();
  await expect(page.locator(".crop-box")).toBeVisible();
  const box = (await page.locator(".crop-box").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  await page.locator(".chip-done").click();
  await expect(page.locator(".crop-box")).toHaveCount(0);
  await page.locator(".vdock-chips .chip", { hasText: "720P" }).click();
  const out = await page.locator(".vdock-out").innerText();
  const [w, h] = out.match(/(\d+) × (\d+)/)!.slice(1).map(Number);
  expect(w).toBe(h);

  // Playback stays inside the trim and never flickers the busy line.
  await page.locator(".vdock-play").click();
  const seen = await page.evaluate(async () => {
    const v = document.querySelector("video")!;
    let lo = Infinity, hi = 0, busy = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      lo = Math.min(lo, v.currentTime);
      hi = Math.max(hi, v.currentTime);
      if (document.querySelector(".viewer-busy")) busy++;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { lo, hi, busy, dur: v.duration };
  });
  expect(seen.lo).toBeGreaterThan(seen.dur * 0.2);
  expect(seen.hi).toBeLessThan(seen.dur * 0.8);
  expect(seen.busy).toBeLessThan(3);
  await page.locator(".vdock-play").click();

  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 300_000 }),
    page.locator(".bar-save .btn-primary").first().click(),
  ]);
  const file = info.outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  // Read the size and length back by loading the file in the page.
  const buf = fs.readFileSync(file);
  const meta = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.src = url;
    await new Promise((r) => (v.onloadedmetadata = r));
    return { w: v.videoWidth, h: v.videoHeight, d: v.duration };
  }, buf.toString("base64"));
  expect(meta.w).toBe(w);
  expect(meta.h).toBe(h);
  expect(meta.d).toBeGreaterThan(0.6);
  expect(meta.d).toBeLessThan(1.4);
  expect(errors).toEqual([]);
});
