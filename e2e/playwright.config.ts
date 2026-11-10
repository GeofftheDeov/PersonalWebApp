/**
 * End-to-end browser tests for the portfolio and Hearthside (#218, spec #69's seam 1).
 *
 *   npm run e2e                                     (repo root) everything
 *   npm run e2e -- tests/hearthside/shell.spec.ts   one file (or -g "<title>" for one test)
 *   npm run e2e -- --project hearthside             one site's specs
 *
 * Needs, once per worktree: `npm ci` at the root, in backend/ and in e2e/, and
 * Chromium (`npx playwright install chromium` in e2e/). PostgreSQL's binaries
 * must be findable, as for the backend's `npm test`.
 *
 * Each run starts its own stack (stack/global-setup.ts): a fresh database on
 * the private test cluster, the backend and both apps on free ports, and the
 * seeded party. The browser reaches the apps at https://geoffthedeov.test:<port>
 * and https://hearthside.geoffthedeov.test:<port>, resolved to 127.0.0.1 by
 * its host-resolver rules (stack/hosts.ts).
 */
import { defineConfig, devices } from "@playwright/test";
import type { Options } from "./fixtures";
import { HOST_RESOLVER_RULES } from "./stack/hosts";

export default defineConfig<Options>({
  testDir: "./tests",
  globalSetup: "./stack/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a test that needs one is flaky, and gets fixed rather than retried.
  retries: 0,
  // The apps run in development mode, so a page's first visit compiles it.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    // The run's certificate is self-signed.
    ignoreHTTPSErrors: true,
    launchOptions: { args: [`--host-resolver-rules=${HOST_RESOLVER_RULES}`] },
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "portfolio", testDir: "./tests/portfolio", use: { ...devices["Desktop Chrome"], site: "portfolio" } },
    { name: "hearthside", testDir: "./tests/hearthside", use: { ...devices["Desktop Chrome"], site: "hearthside" } },
  ],
});
