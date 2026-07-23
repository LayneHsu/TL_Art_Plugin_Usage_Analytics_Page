import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  return errors;
}

test("visitor cannot open admin routes", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=visitor");
  await expect(page.getByRole("heading", { name: "团队概览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "用户统计" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "设备状态" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "门户人员" })).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("admin can open protected routes", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "用户统计" }).click();
  await expect(page.getByRole("heading", { name: "用户统计" })).toBeVisible();
  await page.getByRole("button", { name: "异常趋势" }).click();
  await page.getByRole("button", { name: "查看关联用户与设备" }).first().click();
  await expect(page.getByRole("region", { name: "异常关联用户与设备" })).toContainText("binding-e2e");
  await page.getByRole("button", { name: "门户人员" }).click();
  await expect(page.getByRole("heading", { name: "门户人员与身份" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("error rows show a short fingerprint with the complete value in the tooltip", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "异常趋势" }).click();
  const fingerprints = page.locator(".error-fingerprint");
  await expect(fingerprints).toHaveCount(2);
  await expect(fingerprints.first()).toHaveText("aaaaaaaaaaaa");
  await expect(fingerprints.first()).toHaveAttribute("title", "a".repeat(64));
  expect(errors).toEqual([]);
});

test("error detail pagination preserves the selected composite identity", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "异常趋势" }).click();
  const selectedFrom = await page.getByLabel("开始日期").inputValue();
  const selectedTo = await page.getByLabel("结束日期").inputValue();
  await page.getByLabel("插件版本").fill("1.0.0");
  const selectedRow = page.locator(".error-table .table-row").filter({ hasText: "asset.secondary" });
  await selectedRow.getByRole("button", { name: "查看关联用户与设备" }).click();
  await expect(page.getByRole("button", { name: "加载更多关联记录" })).toBeVisible();

  await page.getByLabel("插件版本").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "2.0.0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByLabel("开始日期").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "2026-07-01";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByLabel("结束日期").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "2026-07-02";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByRole("button", { name: "加载更多关联记录" }).click();
  await expect(page.locator(".error-detail-table .table-row")).toHaveCount(2);

  const requests = await page.evaluate(() => (window as any).__portalE2E.errorDetailRequests);
  expect(requests.map((request: Record<string, unknown>) => ({
    from: request.from,
    to: request.to,
    tool_key: request.tool_key,
    action_key: request.action_key,
    fingerprint: request.fingerprint,
    plugin_version: request.plugin_version ?? null,
  }))).toEqual([
    { from: selectedFrom, to: selectedTo, tool_key: "asset.secondary", action_key: "retry", fingerprint: "a".repeat(64), plugin_version: "1.0.0" },
    { from: selectedFrom, to: selectedTo, tool_key: "asset.secondary", action_key: "retry", fingerprint: "a".repeat(64), plugin_version: "1.0.0" },
  ]);

  await page.getByLabel("开始日期").dispatchEvent("change");
  await expect(page.getByRole("region", { name: "异常关联用户与设备" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("role and status changes revoke access", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "门户人员" }).click();
  await page.evaluate(() => (window as any).__portalE2E.setAccess("visitor", "active"));
  await expect(page.getByRole("heading", { name: "团队概览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "门户人员" })).toHaveCount(0);
  await page.evaluate(() => (window as any).__portalE2E.setAccess("visitor", "disabled"));
  await expect(page.getByRole("heading", { name: "当前账号没有门户访问权限" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a Functions role-change response reloads as visitor before the access watcher", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin&roleChangeOn=portalTeamSummary");
  await expect(page.getByRole("heading", { name: "团队概览" })).toBeVisible();
  await expect(page.locator(".role-tag")).toHaveText("访客");
  await expect(page.getByRole("button", { name: "用户统计" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "当前账号没有门户访问权限" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__portalE2E.signedIn)).toBe(true);
  expect(errors).toEqual([]);
});

test("late preview responses are ignored", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "门户人员" }).click();
  await page.evaluate(() => { (window as any).__portalE2E.deferPreview = true; });
  await page.getByLabel("公司邮箱").last().fill("late@xindong.com");
  await page.getByRole("button", { name: "检查身份" }).click();
  await page.evaluate(() => (window as any).__portalE2E.setAccess("admin", "disabled"));
  await page.evaluate(() => (window as any).__portalE2E.resolvePreview());
  await expect(page.getByRole("heading", { name: "当前账号没有门户访问权限" })).toBeVisible();
  await expect(page.getByText("命中邮箱规则")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("mobile keeps the account role visible", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?role=admin");
  await expect(page.locator(".role-tag")).toBeVisible();
  await expect(page.locator(".role-tag")).toHaveText("管理员");
  expect(errors).toEqual([]);
});

test("tables scroll horizontally", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/?role=admin");
  const table = page.locator(".data-table").first();
  await expect(table).toBeVisible();
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await table.evaluate((element) => { element.scrollLeft = 120; return element.scrollLeft > 0; })).toBe(true);
  expect(errors).toEqual([]);
});

test("keyboard focus is visible", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await expect(page.getByRole("heading", { name: "团队概览" })).toBeVisible();
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  expect(errors).toEqual([]);
});
