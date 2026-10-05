import { defineConfig, devices } from "@playwright/test";

// Run `npm run build` first: the tests drive the exported site in out/.
// Set BASE_URL to test a deployed copy instead (e.g. production).
const external = process.env.BASE_URL;

export default defineConfig({
  testDir: "tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: external ?? "http://localhost:3200",
    launchOptions: { args: ["--enable-unsafe-webgpu", "--enable-gpu"] },
    trace: "retain-on-failure",
  },
  webServer: external
    ? undefined
    : { command: "node tests/serve.mjs out 3200", port: 3200, reuseExistingServer: true },
  projects: [
    { name: "unit", testMatch: /recipe\.spec\.ts/ },
    { name: "desktop", testIgnore: /(recipe|phone)\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", testMatch: /phone\.spec\.ts/, use: { ...devices["Pixel 7"] } },
  ],
});
