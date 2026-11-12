import { defineConfig, devices } from "@playwright/test";

/**
 * Rendered browser journeys for the real CHO desktop UI.
 *
 * These run the actual Vite app in Chromium with deterministic Tauri IPC
 * doubles installed by `e2e/tauri-fixture.ts`. They are NOT WebView2, NOT the
 * installed app, NOT a live provider, and NOT an OS display-scaling
 * qualification. See docs/RENDERED_JOURNEYS.md for the evidence limits.
 *
 * `testDir` is isolated to `./e2e` so Vitest (which collects `src/**\/*.test.*`)
 * never picks up browser specs.
 */
// Dedicated loopback port for the rendered journeys. Never share port 1420
// with Tauri dev servers from other worktrees: a stale server would serve
// another checkout's bundle.
const PORT = 1427;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  // Local, ignored outputs only — never committed binaries.
  outputDir: "./test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Chromium only: this is a browser fixture, not a WebView2 qualification.
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      // Default 1360 x 880 window from PRODUCT_SPEC section 8.
      name: "desktop-1360x880",
      use: { viewport: { width: 1360, height: 880 } },
    },
    {
      // Minimum supported 960 x 720 window from PRODUCT_SPEC section 8.
      name: "narrow-960x720",
      use: { viewport: { width: 960, height: 720 } },
    },
    {
      // Effective 125% Windows scaling: a 1360 x 880 window reports ~1088 x 704
      // CSS pixels. This is a layout-budget approximation, not OS DPI.
      name: "effective-125pct",
      use: { viewport: { width: 1088, height: 704 } },
    },
    {
      // Effective 150% Windows scaling: ~907 x 587 CSS pixels.
      name: "effective-150pct",
      use: { viewport: { width: 907, height: 587 } },
    },
  ],
  webServer: {
    // Dedicated Vite instance on the journey port; never reuse a server that
    // is already listening (it may belong to another worktree).
    command: "npm run dev:vite:e2e",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
