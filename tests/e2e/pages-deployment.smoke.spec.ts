import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.PORTAL_SMOKE_BASE_URL;
const functionsBaseUrl = process.env.PORTAL_SMOKE_FUNCTIONS_BASE_URL;

test.skip(!baseUrl || !functionsBaseUrl, "Remote Pages smoke variables are not configured");

function runtimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  return errors;
}

test("deployed root and history-smoke initialize portal Auth", async ({ page, request }) => {
  await expect.poll(async () => (await request.get(baseUrl!)).status(), { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toBe(200);
  const errors = runtimeErrors(page);
  await page.goto(baseUrl!, { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "使用公司 Google 账号登录" })).toBeVisible();
  await page.goto(new URL("history-smoke", baseUrl!).toString(), { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "使用公司 Google 账号登录" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("deployed Functions answers portal CORS preflight", async ({ request }) => {
  const origin = new URL(baseUrl!).origin;
  const response = await request.fetch(`${functionsBaseUrl!.replace(/\/$/, "")}/portalSession`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
  expect(response.status()).toBe(204);
  expect(response.headers()["access-control-allow-origin"]).toBe(origin);
});
