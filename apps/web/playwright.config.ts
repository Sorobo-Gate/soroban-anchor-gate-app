import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * Mobile / tablet viewport layout tests (`npm run test:e2e`).
 * Install the browser once with `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    // Portrait small tablet below the md (768px) breakpoint, e.g. Galaxy Tab / Nexus 7 class devices.
    {
      name: "tablet",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 712, height: 1138 },
        deviceScaleFactor: 2.25,
        userAgent: devices["Galaxy Tab S4"]?.userAgent ?? devices["Pixel 7"].userAgent,
      },
    },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Production build: matches what users get and avoids dev-server origin restrictions.
        command: `npx next build && npx next start --hostname 127.0.0.1 --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        env: {
          // Same public testnet contract CI uses for `next build` (see .github/workflows/ci.yml).
          NEXT_PUBLIC_ESCROW_CONTRACT_ID:
            process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ?? "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
        },
      },
});
