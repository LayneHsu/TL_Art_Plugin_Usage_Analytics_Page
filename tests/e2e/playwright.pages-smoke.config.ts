import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "pages-deployment.smoke.spec.ts",
  timeout: 150_000,
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium" }],
});
