import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, "utf8");

test("portal and plugin pairing routes remain separate browser surfaces", () => {
  const app = read("web/src/App.vue");
  const pairing = read("web/src/plugin-pairing/PluginPairingPage.vue");
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(app, /defineAsyncComponent/);
  assert.match(app, /isPluginPairingRoute[\s\S]*import\("\.\/plugin-pairing\/PluginPairingPage\.vue"\)[\s\S]*import\("\.\/portal\/PortalApp\.vue"\)/);
  assert.doesNotMatch(app, /import\s+PortalApp\s+from/);
  assert.doesNotMatch(pairing, /firebase\/auth|portalSession|portalUsers|visitor|admin/);
  assert.doesNotMatch(portal, /pairing_secret|pluginDevice|pluginRenewLease|localStorage/);
});

test("portal auth uses Firebase ID tokens and clears protected state on revocation", () => {
  const firebase = read("web/src/portal/firebase.ts");
  const api = read("web/src/portal/api.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(firebase, /GoogleAuthProvider/);
  assert.match(api, /getIdToken/);
  assert.match(api, /PortalAccessRevokedError/);
  assert.match(portal, /function clearProtectedState[\s\S]*requestController\?\.abort\(\)[\s\S]*principalRows\.value = \[\][\s\S]*deviceRows\.value = \[\]/s);
  assert.match(portal, /function requestIsCurrent[\s\S]*generation === requestGeneration[\s\S]*user\.value\?\.uid === uid/);
  assert.match(portal, /watchPortalUser[\s\S]*clearProtectedState\(\)/s);
  assert.match(portal, /PortalAccessRevokedError[\s\S]*handleAccessRevoked/s);
});

test("portal API distinguishes role changes, access revocation, and internal failures", () => {
  const api = read("web/src/portal/api.ts");
  assert.match(api, /portal_admin_required[\s\S]*portal_role_changed[\s\S]*PortalRoleChangedError/);
  assert.match(api, /\["portal_access_denied",\s*"portal_disabled",\s*"invalid_identity",\s*"company_account_required"\]/);
  assert.doesNotMatch(api, /response\.status\s*===\s*401\s*\|\|/);
});

test("portal watches the signed-in user's access document and exposes a dedicated revoked state", () => {
  const firebase = read("web/src/portal/firebase.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  const app = read("web/src/App.vue");
  assert.match(firebase, /from "firebase\/firestore"/);
  assert.match(firebase, /function watchPortalAccess/);
  assert.match(firebase, /doc\([^\n]*"portalUsers"[^\n]*user\.uid/);
  assert.match(firebase, /onSnapshot/);
  assert.match(portal, /watchPortalAccess/);
  assert.match(portal, /stopAccess\?\.\(\)/);
  assert.match(portal, /accessRevoked\.value = true/);
  assert.match(portal, /v-else-if="accessRevoked"[\s\S]*当前账号没有门户访问权限/);
  assert.doesNotMatch(app, /from "\.\/portal\/firebase"/);
});

test("revocation clears every user-scoped input and prevents late policy previews", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(portal, /function clearProtectedState[\s\S]*principalFilter\.value = ""[\s\S]*peopleSearch\.value = ""/s);
  assert.match(portal, /function clearProtectedState[\s\S]*policyValue\.value = ""[\s\S]*policyPreviewEmail\.value = ""/s);
  assert.match(portal, /previewController\?\.abort\(\)/);
  assert.match(portal, /previewGeneration/);
  assert.match(portal, /portalRequest<PolicyPreview>[\s\S]*previewController\.signal/);
  assert.match(portal, /generation === previewGeneration[\s\S]*requestIsCurrent/s);
});

test("admin demotion refreshes as visitor instead of treating it as full access revocation", () => {
  const api = read("web/src/portal/api.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(api, /class PortalRoleChangedError extends Error/);
  assert.match(api, /portal_admin_required[\s\S]*PortalRoleChangedError/);
  const revokedBranch = api.match(/if \(\["portal_access_denied"[\s\S]*?throw new PortalAccessRevokedError[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.notEqual(revokedBranch, "");
  assert.doesNotMatch(revokedBranch, /portal_admin_required|portal_role_changed/);
  assert.match(portal, /PortalRoleChangedError/);
  assert.match(portal, /function handleRoleChanged[\s\S]*clearProtectedState\(\)[\s\S]*role: "visitor"[\s\S]*loadView\(\)/s);
});

test("admins can inspect allowlisted error associations without exposing raw logs", () => {
  const api = read("web/src/portal/api.ts");
  const portal = read("web/src/portal/PortalApp.vue");
  const index = read("functions/src/index.ts");
  assert.match(api, /interface ErrorDetailRow[\s\S]*event_id[\s\S]*plugin_principal_id[\s\S]*binding_id[\s\S]*observed_at[\s\S]*received_at/);
  assert.match(api, /interface ErrorDetailRow[\s\S]*binding_id:\s*string;/);
  assert.match(portal, /portalErrorDetails/);
  assert.match(portal, /portalErrorDetails[\s\S]*tool_key:\s*row\.tool_key[\s\S]*action_key:\s*row\.action_key/);
  assert.match(portal, /v-if="isAdmin"[\s\S]*查看关联用户与设备/);
  assert.match(portal, /errorDetailRows/);
  assert.match(index, /portalErrorDetails/);
  assert.doesNotMatch(api, /raw_log|traceback/);
});

test("error summary rows expose a recognizable short fingerprint without losing the full value", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(portal, /class="error-fingerprint"/);
  assert.match(portal, /row\.fingerprint\.slice\(0,\s*12\)/);
  assert.match(portal, /:title="row\.fingerprint"/);
});

test("portal exposes role-aware reports and guarded people management", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(portal, /团队概览/);
  assert.match(portal, /异常趋势/);
  assert.match(portal, /v-if="isAdmin"[\s\S]*用户统计/s);
  assert.match(portal, /v-if="isAdmin"[\s\S]*设备状态/s);
  assert.match(portal, /v-if="isAdmin"[\s\S]*门户人员/s);
  assert.match(portal, /window\.confirm/);
  assert.match(portal, /portalPolicies/);
  assert.match(portal, /person\.uid === session\.uid/);
  assert.match(portal, /toolFilter/);
  assert.match(portal, /actionFilter/);
  assert.match(portal, /resultFilter/);
  assert.match(portal, /errorFingerprintFilter/);
  assert.match(portal, /errorVersionFilter/);
});

test("people management previews the effective portal role with email precedence", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  const api = read("web/src/portal/api.ts");
  const endpoints = read("functions/src/portal/endpoints.ts");
  assert.match(api, /interface PolicyPreview/);
  assert.match(portal, /policyPreviewEmail/);
  assert.match(portal, /operation:\s*"preview"/);
  assert.match(portal, /最终生效身份/);
  assert.match(portal, /邮箱规则优先/);
  assert.match(endpoints, /input\.operation === "preview"[\s\S]*previewPolicy/);
});

test("people and account views show identity details and allow confirmed policy toggles", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  assert.match(portal, /session\.photo_url[\s\S]*large-avatar/);
  assert.match(portal, /person\.photo_url/);
  assert.match(portal, /person\.first_login_at/);
  assert.match(portal, /person\.last_login_at/);
  assert.match(portal, /function togglePolicy/);
  assert.match(portal, /enabled:\s*!policy\.enabled/);
  assert.match(portal, /type="checkbox"[\s\S]*togglePolicy\(policy/);
});

test("admin reports keep plugin principals separate and clear sensitive rows on revocation", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  const api = read("web/src/portal/api.ts");
  const store = read("functions/src/portal/firestore-store.ts");
  assert.match(api, /interface PrincipalUsageRow[\s\S]*plugin_principal_id[\s\S]*tool_key[\s\S]*action_key[\s\S]*profile_updated_at/);
  assert.match(api, /interface PluginDeviceRow[\s\S]*binding_id/);
  assert.match(store, /plugin_principal_id[\s\S]*tool_key[\s\S]*action_key/);
  assert.match(portal, /portalPrincipalUsage/);
  assert.match(portal, /principalFilter/);
  assert.match(portal, /plugin_principal_id:\s*principalFilter\.value/);
  assert.match(portal, /portalDevices/);
  assert.match(portal, /row\.plugin_principal_id[^\n]*row\.tool_key[^\n]*row\.action_key/);
  assert.match(portal, /身份已变化/);
  assert.match(api, /interface PrincipalUsageRow[\s\S]*daily_trend/);
  assert.match(portal, /使用趋势/);
  assert.match(portal, /row\.daily_trend/);
  assert.match(portal, /principalRows\.value = \[\][\s\S]*deviceRows\.value = \[\][\s\S]*signOutPortal/s);
  assert.doesNotMatch(portal, /credentialDigest|deviceIdDigest|leaseToken|refreshToken/);
});

test("portal Functions authorize with portal identity and never reuse plugin leases", () => {
  const endpoints = read("functions/src/portal/endpoints.ts");
  const service = read("functions/src/portal/service.ts");
  assert.match(endpoints, /verifyIdToken/);
  assert.match(service, /portal_admin_required/);
  assert.match(service, /last_admin_protected/);
  assert.doesNotMatch(`${endpoints}\n${service}`, /verifyLeaseToken|pluginRenewLease|pluginDeviceBindings/);
});

test("Pages deployment injects the portal Functions endpoint", () => {
  const workflow = read(".github/workflows/deploy-pages.yml");
  assert.match(workflow, /PORTAL_FUNCTIONS_BASE_URL:\s*\$\{\{\s*vars\.PORTAL_FUNCTIONS_BASE_URL\s*\}\}/);
});

test("portal date defaults and mobile account role use the company timezone", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  const style = read("web/src/style.css");
  assert.match(portal, /function companyDate[\s\S]*timeZone:\s*"Asia\/Shanghai"/);
  assert.doesNotMatch(style, /@media \(max-width:\s*520px\)[\s\S]*\.role-tag\s*\{\s*display:\s*none/);
});

test("portal report views retain server cursors and search people on the server", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  const api = read("web/src/portal/api.ts");
  assert.match(api, /interface PortalPage<T>[\s\S]*items:\s*T\[\][\s\S]*next_cursor:\s*string \| null/);
  for (const cursor of ["teamCursor", "principalCursor", "deviceCursor", "errorCursor", "peopleCursor"]) assert.match(portal, new RegExp(cursor));
  assert.match(portal, /peopleSearch/);
  assert.match(portal, /operation:\s*"list"[\s\S]*search:\s*peopleSearch\.value/);
  assert.match(portal, /next_cursor/);
  assert.match(portal, /function loadMore/);
  assert.match(portal, />加载更多</);
});

test("portal distinguishes observed, received and corrected event time", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  const api = read("web/src/portal/api.ts");
  assert.match(api, /interface TeamSummaryRow[\s\S]*last_used_at[\s\S]*last_received_at[\s\S]*time_corrected_count/);
  assert.match(api, /interface ErrorRow[\s\S]*first_received_at[\s\S]*recent_received_at[\s\S]*time_corrected_count[\s\S]*affected_versions/);
  assert.match(api, /interface ErrorRow[\s\S]*distinct_users/);
  assert.match(portal, /接收.*last_received_at/);
  assert.match(portal, /已校正.*time_corrected_count/);
  assert.match(portal, /首次.*first_seen_at/);
});

test("team totals and failure trend are independent from the loaded result page", () => {
  const portal = read("web/src/portal/PortalApp.vue");
  const api = read("web/src/portal/api.ts");
  assert.match(api, /interface TeamSummaryPage extends PortalPage<TeamSummaryRow>[\s\S]*summary[\s\S]*failure_trend/);
  assert.match(portal, /teamSummary\.value = result\.summary/);
  assert.match(portal, /failureTrend\.value = result\.failure_trend/);
  assert.match(portal, /失败趋势/);
});
