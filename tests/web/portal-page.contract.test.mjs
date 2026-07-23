import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (relativePath) => readFileSync(`${root}/${relativePath}`, "utf8");

test("portal uses Firebase Auth and direct Firestore without server endpoints", () => {
  const firebase = read("web/src/portal/firebase.ts");
  const store = read("web/src/portal/store.ts");
  const api = read("web/src/portal/api.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  const source = `${firebase}\n${store}\n${api}\n${portal}`;
  assert.match(firebase, /GoogleAuthProvider/);
  assert.match(firebase, /watchPortalMember/);
  assert.match(store, /getDocs/);
  assert.match(store, /usageDaily/);
  assert.match(store, /errorLogs/);
  assert.match(store, /portalMembers/);
  assert.doesNotMatch(source, /FUNCTIONS_BASE_URL|portalRequest|Bearer |pairing|lease|binding_id|plugin_principal_id/);
});

test("analytics aggregates every event once and counts run_started usage", () => {
  const analytics = read("web/src/portal/analytics.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(analytics, /event_id/);
  assert.match(analytics, /Set/);
  assert.match(analytics, /run_started/);
  assert.match(analytics, /dailyTrend|daily_trend/);
  assert.match(portal, /aggregateUsage/);
  assert.match(portal, /活跃用户/);
  assert.match(portal, /5_000|5,000/);
});

test("portal clears protected state on account or role changes", () => {
  const firebase = read("web/src/portal/firebase.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(firebase, /onAuthStateChanged/);
  assert.match(firebase, /onSnapshot/);
  assert.match(portal, /function clearProtectedState/);
  assert.match(portal, /requestGeneration/);
  assert.match(portal, /controller\?\.abort\(\)/);
  assert.match(portal, /portalMembers/);
  assert.match(portal, /没有查看权限/);
});

test("role-aware portal keeps member management and cleanup admin-only", () => {
  const store = read("web/src/portal/store.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(store, /setDoc/);
  assert.match(store, /updateDoc/);
  assert.match(store, /deleteDoc/);
  assert.match(portal, /v-if="isAdmin"[\s\S]*成员管理/s);
  assert.match(portal, /window\.confirm/);
  assert.match(portal, /导出/);
  assert.match(portal, /清理/);
  assert.doesNotMatch(portal, /预授权|准入规则|设备状态|租约/);
});

test("portal exposes user, tool, action, result, date, and error filters", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  for (const phrase of ["用户", "工具", "动作", "结果", "开始日期", "结束日期", "异常日志"]) {
    assert.match(portal, new RegExp(phrase));
  }
  assert.match(portal, /userFilter/);
  assert.match(portal, /toolFilter/);
  assert.match(portal, /actionFilter/);
  assert.match(portal, /resultFilter/);
});

test("Pages build exposes only public Firebase configuration", () => {
  const workflow = read(".github/workflows/deploy-pages.yml");
  const vite = read("web/vite.config.ts");
  assert.match(workflow, /PORTAL_FIREBASE_API_KEY/);
  assert.match(workflow, /PORTAL_FIREBASE_PROJECT_ID/);
  assert.doesNotMatch(workflow, /FUNCTIONS|SECRET|WORKLOAD_IDENTITY/i);
  assert.doesNotMatch(vite, /FUNCTIONS_BASE_URL/);
});
