import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4178", headless: true },
  webServer: [
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4178 --strictPort",
      url: "http://127.0.0.1:4178",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run build && node scripts/static-server.mjs",
      url: "http://127.0.0.1:4180",
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args:
            process.env.WEBGPU_TEST === "1"
              ? process.platform === "darwin"
                ? ["--enable-unsafe-webgpu", "--use-angle=metal"]
                : ["--enable-unsafe-webgpu"]
              : [],
        },
      },
    },
  ],
});
