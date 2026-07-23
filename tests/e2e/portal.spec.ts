import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  return errors;
}

test("viewer cannot open admin routes", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=viewer");
  await expect(page.getByRole("heading", { name: "使用概览" })).toBeVisible();
  await expect(page.getByText("使用次数", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "成员管理" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "数据管理" })).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("admin can inspect users, tools, events, errors and cleanup", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await expect(page.getByText("使用次数").locator(".." ).getByRole("strong")).toHaveText("3");
  await expect(page.getByText("成功率").locator(".." ).getByRole("strong")).toHaveText("67%");
  await page.getByRole("button", { name: "用户统计" }).click();
  await expect(page.getByRole("heading", { name: "用户统计" })).toBeVisible();
  await expect(page.getByText("美术一", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "工具统计" }).click();
  await expect(page.getByText("asset.importer").first()).toBeVisible();
  await page.getByRole("button", { name: "使用明细" }).click();
  await expect(page.locator(".event-table .table-row")).toHaveCount(3);
  await page.getByRole("button", { name: "异常日志" }).click();
  await expect(page.locator(".error-fingerprint")).toHaveText("aaaaaaaaaaaa");
  await page.locator("details").first().click();
  await expect(page.locator(".error-log-table pre")).toContainText("Traceback");
  await page.getByRole("button", { name: "数据管理" }).click();
  await page.getByRole("button", { name: "检查数量" }).click();
  await expect(page.getByText("5").first()).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "确认清理" }).click();
  await expect(page.getByText("已删除 5 个文档")).toBeVisible();
  expect(errors).toEqual([]);
});

test("event aggregation deduplicates shards and joins terminal results", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "使用明细" }).click();
  await expect(page.locator(".event-table .table-row")).toHaveCount(3);
  await expect(page.locator(".event-table")).toContainText("成功");
  await expect(page.locator(".event-table")).toContainText("失败");
  await expect(page.locator(".event-table")).not.toContainText("开始");
  expect(errors).toEqual([]);
});

test("admin can manage members without changing own access", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "成员管理" }).click();
  await page.getByLabel("成员邮箱").fill("new.viewer@xindong.com");
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "增加成员" }).click();
  await expect(page.getByText("new.viewer@xindong.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "移除" }).first()).toBeDisabled();
  expect(errors).toEqual([]);
});

test("role and status changes clear protected data", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.evaluate(() => (window as any).__portalE2E.setMember("viewer", true));
  await expect(page.getByRole("heading", { name: "使用概览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "成员管理" })).toHaveCount(0);
  await page.evaluate(() => (window as any).__portalE2E.setMember("viewer", false));
  await expect(page.getByRole("heading", { name: "当前账号没有查看权限" })).toBeVisible();
  await expect(page.getByText("asset.importer")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("filters narrow users and results without another server API", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.goto("/?role=admin");
  await page.getByRole("button", { name: "使用明细" }).click();
  await page.getByLabel("用户").selectOption("artist-2");
  await expect(page.locator(".event-table .table-row")).toHaveCount(1);
  await expect(page.locator(".event-table")).toContainText("美术二");
  expect(errors).toEqual([]);
});

test("mobile keeps account role visible and tables scroll", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/?role=admin");
  await expect(page.locator(".role-tag")).toHaveText("管理员");
  const table = page.locator(".data-table").first();
  await expect(table).toBeVisible();
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await table.evaluate((element) => { element.scrollLeft = 120; return element.scrollLeft > 0; })).toBe(true);
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  expect(await focused.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  expect(errors).toEqual([]);
});
