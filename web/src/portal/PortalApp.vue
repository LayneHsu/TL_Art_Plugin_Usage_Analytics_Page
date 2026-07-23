<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { User } from "firebase/auth";
import { signInPortal, signOutPortal, watchPortalAccess, watchPortalUser } from "./firebase";
import { portalRequest, PortalAccessRevokedError, PortalRoleChangedError, type AccessPolicyRow, type ErrorDetailRow, type ErrorRow, type PersonRow, type PluginDeviceRow, type PolicyPreview, type PortalPage, type PortalSession, type PrincipalUsageRow, type TeamSummaryPage, type TeamSummaryRow } from "./api";

const user = ref<User | null>(null);
const session = ref<PortalSession | null>(null);
const authLoading = ref(true);
const accessRevoked = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const activeView = ref<"overview" | "principals" | "devices" | "errors" | "account" | "people">("overview");
const teamRows = ref<TeamSummaryRow[]>([]);
const teamSummary = ref({ run_started: 0, run_succeeded: 0, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 0 });
const failureTrend = ref<Array<{ date: string; run_failed: number; run_interrupted: number }>>([]);
const errorRows = ref<ErrorRow[]>([]);
const errorDetailRows = ref<ErrorDetailRow[]>([]);
type SelectedErrorIdentity = Readonly<{
  from: string;
  to: string;
  fingerprint: string;
  tool_key: string;
  action_key: string;
  plugin_version: string | null;
}>;
const selectedError = ref<SelectedErrorIdentity | null>(null);
const errorDetailCursor = ref<string | null>(null);
const errorDetailLoading = ref(false);
const principalRows = ref<PrincipalUsageRow[]>([]);
const deviceRows = ref<PluginDeviceRow[]>([]);
const people = ref<PersonRow[]>([]);
const policies = ref<AccessPolicyRow[]>([]);
const peopleSearch = ref("");
const teamCursor = ref<string | null>(null);
const principalCursor = ref<string | null>(null);
const deviceCursor = ref<string | null>(null);
const errorCursor = ref<string | null>(null);
const peopleCursor = ref<string | null>(null);
const policyCursor = ref<string | null>(null);
const policyKind = ref<"email" | "domain">("email");
const policyValue = ref("");
const policyRole = ref<"visitor" | "admin">("visitor");
const policyPreviewEmail = ref("");
const policyPreview = ref<PolicyPreview | null>(null);
const policyPreviewLoading = ref(false);
const toolFilter = ref("");
const actionFilter = ref("");
const resultFilter = ref("");
const errorFingerprintFilter = ref("");
const errorVersionFilter = ref("");
const principalFilter = ref("");
const dateFrom = ref(companyDate(-29));
const dateTo = ref(companyDate());
let stopAuth: (() => void) | undefined;
let stopAccess: (() => void) | undefined;
let refreshTimer: number | undefined;
let requestController: AbortController | undefined;
let requestGeneration = 0;
let previewController: AbortController | undefined;
let previewGeneration = 0;
let errorDetailController: AbortController | undefined;
let errorDetailGeneration = 0;

const isAdmin = computed(() => session.value?.role === "admin");
const initials = computed(() => (session.value?.display_name || session.value?.email || "?").slice(0, 1).toUpperCase());
const totalRuns = computed(() => teamSummary.value.run_started);
const totalFailures = computed(() => teamSummary.value.run_failed + teamSummary.value.run_interrupted);
const successRate = computed(() => totalRuns.value ? Math.round((teamSummary.value.run_succeeded / totalRuns.value) * 100) : 0);
const failureTrendMax = computed(() => Math.max(1, ...failureTrend.value.map((point) => point.run_failed + point.run_interrupted)));
const principalEmailCounts = computed(() => principalRows.value.reduce((principals, row) => {
  const email = row.email?.trim().toLowerCase();
  if (email) {
    const ids = principals.get(email) ?? new Set<string>();
    ids.add(row.plugin_principal_id);
    principals.set(email, ids);
  }
  return principals;
}, new Map<string, Set<string>>()));
const viewTitle = computed(() => ({ overview: "团队概览", principals: "用户统计", devices: "设备状态", errors: "异常趋势", people: "门户人员与身份", account: "我的账号" })[activeView.value]);
const viewEyebrow = computed(() => ({ overview: "TEAM PULSE", principals: "PLUGIN PRINCIPALS", devices: "DEVICE HEALTH", errors: "DIAGNOSTICS", people: "ACCESS CONTROL", account: "ACCOUNT" })[activeView.value]);
const hasMore = computed(() => ({ overview: teamCursor.value, principals: principalCursor.value, devices: deviceCursor.value, errors: errorCursor.value, people: peopleCursor.value || policyCursor.value, account: null })[activeView.value]);

function companyDate(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function filters() {
  return {
    from: dateFrom.value,
    to: dateTo.value,
    limit: 100,
    tool_key: toolFilter.value || undefined,
    action_key: actionFilter.value || undefined,
    result: resultFilter.value || undefined,
  };
}

function errorFilters() {
  return {
    ...filters(),
    fingerprint: errorFingerprintFilter.value.trim() || undefined,
    plugin_version: errorVersionFilter.value.trim() || undefined,
  };
}

function principalFilters() {
  return {
    ...filters(),
    plugin_principal_id: principalFilter.value || undefined,
  };
}

function clearErrorDetails(): void {
  errorDetailGeneration += 1;
  errorDetailController?.abort();
  errorDetailController = undefined;
  errorDetailRows.value = [];
  selectedError.value = null;
  errorDetailCursor.value = null;
  errorDetailLoading.value = false;
}

function clearProtectedState(): void {
  requestGeneration += 1;
  requestController?.abort();
  requestController = undefined;
  previewGeneration += 1;
  previewController?.abort();
  previewController = undefined;
  clearErrorDetails();
  teamRows.value = [];
  teamSummary.value = { run_started: 0, run_succeeded: 0, run_failed: 0, run_cancelled: 0, run_interrupted: 0, distinct_users: 0 };
  failureTrend.value = [];
  errorRows.value = [];
  principalRows.value = [];
  deviceRows.value = [];
  people.value = [];
  policies.value = [];
  policyPreview.value = null;
  policyPreviewLoading.value = false;
  toolFilter.value = "";
  actionFilter.value = "";
  resultFilter.value = "";
  errorFingerprintFilter.value = "";
  errorVersionFilter.value = "";
  principalFilter.value = "";
  peopleSearch.value = "";
  policyKind.value = "email";
  policyValue.value = "";
  policyRole.value = "visitor";
  policyPreviewEmail.value = "";
  dateFrom.value = companyDate(-29);
  dateTo.value = companyDate();
  teamCursor.value = null;
  principalCursor.value = null;
  deviceCursor.value = null;
  errorCursor.value = null;
  peopleCursor.value = null;
  policyCursor.value = null;
  loading.value = false;
}

function requestIsCurrent(generation: number, uid: string): boolean {
  return generation === requestGeneration && user.value?.uid === uid;
}

async function handleAccessRevoked(message = "门户访问权限已失效"): Promise<void> {
  stopAccess?.();
  stopAccess = undefined;
  clearProtectedState();
  session.value = null;
  activeView.value = "overview";
  accessRevoked.value = true;
  errorMessage.value = message;
  await signOutPortal().catch(() => undefined);
}

function startAccessWatch(currentUser: User): void {
  stopAccess?.();
  stopAccess = watchPortalAccess(currentUser, (access) => {
    if (user.value?.uid !== currentUser.uid) return;
    if (!access || access.status !== "active") {
      void handleAccessRevoked("当前公司账号的门户访问权限已被撤销");
      return;
    }
    if (session.value && session.value.role !== access.role) {
      const currentSession = session.value;
      clearProtectedState();
      activeView.value = "overview";
      session.value = { ...currentSession, role: access.role };
      void loadView();
    }
  }, () => { void handleAccessRevoked("无法确认当前账号的门户访问权限"); });
}

async function handleRoleChanged(): Promise<void> {
  if (!session.value) return;
  const currentSession = session.value;
  clearProtectedState();
  activeView.value = "overview";
  session.value = { ...currentSession, role: "visitor" };
  await loadView();
}

async function loadView(append = false): Promise<void> {
  if (!user.value || !session.value) return;
  if (activeView.value === "errors" && !append) clearErrorDetails();
  const currentUser = user.value;
  const generation = ++requestGeneration;
  loading.value = true;
  errorMessage.value = "";
  requestController?.abort();
  requestController = new AbortController();
  try {
    const latestSession = await portalRequest<PortalSession>(currentUser, "portalSession", {}, requestController.signal);
    if (!requestIsCurrent(generation, currentUser.uid)) return;
    session.value = latestSession;
    if (!isAdmin.value && ["principals", "devices", "people"].includes(activeView.value)) {
      principalRows.value = [];
      deviceRows.value = [];
      people.value = [];
      policies.value = [];
      activeView.value = "overview";
    }
    if (activeView.value === "overview") {
      const result = await portalRequest<TeamSummaryPage>(currentUser, "portalTeamSummary", { ...filters(), cursor: append ? teamCursor.value : undefined }, requestController.signal);
      if (requestIsCurrent(generation, currentUser.uid)) {
        teamRows.value = append ? [...teamRows.value, ...result.items] : result.items;
        teamSummary.value = result.summary;
        failureTrend.value = result.failure_trend;
        teamCursor.value = result.next_cursor;
      }
    }
    if (activeView.value === "errors") {
      const result = await portalRequest<PortalPage<ErrorRow>>(currentUser, "portalErrors", { ...errorFilters(), cursor: append ? errorCursor.value : undefined }, requestController.signal);
      if (requestIsCurrent(generation, currentUser.uid)) {
        errorRows.value = append ? [...errorRows.value, ...result.items] : result.items;
        errorCursor.value = result.next_cursor;
      }
    }
    if (activeView.value === "principals") {
      const result = await portalRequest<PortalPage<PrincipalUsageRow>>(currentUser, "portalPrincipalUsage", { ...principalFilters(), cursor: append ? principalCursor.value : undefined }, requestController.signal);
      if (requestIsCurrent(generation, currentUser.uid)) {
        principalRows.value = append ? [...principalRows.value, ...result.items] : result.items;
        principalCursor.value = result.next_cursor;
      }
    }
    if (activeView.value === "devices") {
      const result = await portalRequest<PortalPage<PluginDeviceRow>>(currentUser, "portalDevices", { limit: 100, cursor: append ? deviceCursor.value : undefined }, requestController.signal);
      if (requestIsCurrent(generation, currentUser.uid)) {
        deviceRows.value = append ? [...deviceRows.value, ...result.items] : result.items;
        deviceCursor.value = result.next_cursor;
      }
    }
    if (activeView.value === "people") {
      if (!isAdmin.value) { activeView.value = "overview"; return; }
      if (!append || peopleCursor.value) {
        const result = await portalRequest<PortalPage<PersonRow>>(currentUser, "portalPeople", { operation: "list", limit: 100, cursor: append ? peopleCursor.value : undefined, search: peopleSearch.value }, requestController.signal);
        if (!requestIsCurrent(generation, currentUser.uid)) return;
        people.value = append ? [...people.value, ...result.items] : result.items;
        peopleCursor.value = result.next_cursor;
      }
      if (!append || policyCursor.value) {
        const policyResult = await portalRequest<PortalPage<AccessPolicyRow>>(currentUser, "portalPolicies", { operation: "list", limit: 100, cursor: append ? policyCursor.value : undefined }, requestController.signal);
        if (requestIsCurrent(generation, currentUser.uid)) {
          policies.value = append ? [...policies.value, ...policyResult.items] : policyResult.items;
          policyCursor.value = policyResult.next_cursor;
        }
      }
    }
  } catch (error) {
    if (error instanceof PortalRoleChangedError) {
      await handleRoleChanged();
    } else if (error instanceof PortalAccessRevokedError) {
      await handleAccessRevoked();
    } else if ((error as { name?: string }).name !== "AbortError") {
      errorMessage.value = error instanceof Error ? error.message : "请求失败";
    }
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

async function login(): Promise<void> {
  accessRevoked.value = false;
  errorMessage.value = "";
  try { await signInPortal(); } catch (error) { errorMessage.value = error instanceof Error ? error.message : "登录未完成"; }
}

async function logout(): Promise<void> {
  stopAccess?.();
  stopAccess = undefined;
  clearProtectedState();
  session.value = null;
  accessRevoked.value = false;
  activeView.value = "overview";
  await signOutPortal();
}

async function savePolicy(): Promise<void> {
  if (!user.value || !policyValue.value.trim()) return;
  const value = policyValue.value.trim().toLowerCase();
  if (!window.confirm(`确认保存 ${value} 的门户准入规则？`)) return;
  try {
    await portalRequest(user.value, "portalPolicies", { operation: "upsert", kind: policyKind.value, value, role: policyKind.value === "domain" ? "visitor" : policyRole.value, enabled: true, confirmation: value });
    policyValue.value = "";
    await loadView();
  } catch (error) {
    if (error instanceof PortalRoleChangedError) await handleRoleChanged();
    else if (error instanceof PortalAccessRevokedError) await handleAccessRevoked();
    else errorMessage.value = error instanceof Error ? error.message : "保存失败";
  }
}

async function previewPolicy(): Promise<void> {
  if (!user.value || !policyPreviewEmail.value.trim()) return;
  const currentUser = user.value;
  const generation = ++previewGeneration;
  previewController?.abort();
  previewController = new AbortController();
  policyPreviewLoading.value = true;
  policyPreview.value = null;
  try {
    const result = await portalRequest<PolicyPreview>(currentUser, "portalPolicies", { operation: "preview", email: policyPreviewEmail.value.trim() }, previewController.signal);
    if (generation === previewGeneration && requestIsCurrent(requestGeneration, currentUser.uid)) policyPreview.value = result;
  } catch (error) {
    if (error instanceof PortalRoleChangedError) await handleRoleChanged();
    else if (error instanceof PortalAccessRevokedError) await handleAccessRevoked();
    else if ((error as { name?: string }).name !== "AbortError") errorMessage.value = error instanceof Error ? error.message : "身份预览失败";
  } finally {
    if (generation === previewGeneration) policyPreviewLoading.value = false;
  }
}

async function loadErrorDetails(identity: SelectedErrorIdentity, append = false): Promise<void> {
  if (!user.value || !session.value || !isAdmin.value) return;
  const currentUser = user.value;
  const generation = ++errorDetailGeneration;
  errorDetailController?.abort();
  errorDetailController = new AbortController();
  errorDetailLoading.value = true;
  if (!append) {
    errorDetailRows.value = [];
    errorDetailCursor.value = null;
  }
  try {
    const result = await portalRequest<PortalPage<ErrorDetailRow>>(currentUser, "portalErrorDetails", {
      from: identity.from,
      to: identity.to,
      limit: 100,
      tool_key: identity.tool_key,
      action_key: identity.action_key,
      fingerprint: identity.fingerprint,
      plugin_version: identity.plugin_version ?? undefined,
      cursor: append ? errorDetailCursor.value : undefined,
    }, errorDetailController.signal);
    if (generation === errorDetailGeneration && requestIsCurrent(requestGeneration, currentUser.uid)) {
      errorDetailRows.value = append ? [...errorDetailRows.value, ...result.items] : result.items;
      errorDetailCursor.value = result.next_cursor;
    }
  } catch (error) {
    if (error instanceof PortalRoleChangedError) await handleRoleChanged();
    else if (error instanceof PortalAccessRevokedError) await handleAccessRevoked();
    else if ((error as { name?: string }).name !== "AbortError") errorMessage.value = error instanceof Error ? error.message : "关联明细加载失败";
  } finally {
    if (generation === errorDetailGeneration) errorDetailLoading.value = false;
  }
}

function openErrorDetails(row: ErrorRow): void {
  const identity = Object.freeze({
    from: dateFrom.value,
    to: dateTo.value,
    fingerprint: row.fingerprint,
    tool_key: row.tool_key,
    action_key: row.action_key,
    plugin_version: errorVersionFilter.value.trim() || null,
  });
  selectedError.value = identity;
  void loadErrorDetails(identity);
}

async function togglePolicy(policy: AccessPolicyRow): Promise<void> {
  if (!user.value) return;
  const action = policy.enabled ? "停用" : "启用";
  if (!window.confirm(`确认${action} ${policy.normalized_value} 的门户准入规则？`)) return;
  try {
    await portalRequest(user.value, "portalPolicies", { operation: "upsert", kind: policy.kind, value: policy.normalized_value, role: policy.kind === "domain" ? "visitor" : policy.role, enabled: !policy.enabled, confirmation: policy.normalized_value });
    policyPreview.value = null;
    await loadView();
  } catch (error) {
    if (error instanceof PortalRoleChangedError) await handleRoleChanged();
    else if (error instanceof PortalAccessRevokedError) await handleAccessRevoked();
    else errorMessage.value = error instanceof Error ? error.message : "规则状态更新失败";
  }
}

async function changePerson(person: PersonRow, change: { role?: "visitor" | "admin"; status?: "active" | "disabled" | "removed" }): Promise<void> {
  if (!user.value || person.uid === session.value?.uid) return;
  if (!window.confirm(`确认修改 ${person.display_name} 的门户访问权限？`)) return;
  try {
    await portalRequest(user.value, "portalPeople", { operation: "update", target_uid: person.uid, confirmation: person.uid, ...change });
    await loadView();
  } catch (error) {
    if (error instanceof PortalRoleChangedError) await handleRoleChanged();
    else if (error instanceof PortalAccessRevokedError) await handleAccessRevoked();
    else errorMessage.value = error instanceof Error ? error.message : "修改失败";
  }
}

function formatTime(value: string | null): string {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function principalIdentityChanged(row: PrincipalUsageRow): boolean {
  const email = row.email?.trim().toLowerCase();
  return row.identity_changed || Boolean(email && (principalEmailCounts.value.get(email)?.size ?? 0) > 1);
}

function visiblePrincipalTrend(row: PrincipalUsageRow) {
  return row.daily_trend.slice(-14);
}

function principalTrendMax(row: PrincipalUsageRow): number {
  return Math.max(1, ...visiblePrincipalTrend(row).map((point) => point.run_started));
}

function principalTrendLabel(row: PrincipalUsageRow): string {
  return `使用趋势：${visiblePrincipalTrend(row).map((point) => `${point.date} ${point.run_started} 次`).join("，") || "暂无"}`;
}

function personInitials(person: PersonRow): string {
  return (person.display_name || person.normalized_email || "?").slice(0, 1).toUpperCase();
}

function switchView(view: typeof activeView.value): void {
  activeView.value = view;
  void loadView();
}

function loadMore(): void {
  if (hasMore.value) void loadView(true);
}

onMounted(() => {
  stopAuth = watchPortalUser(async (nextUser) => {
    stopAccess?.();
    stopAccess = undefined;
    clearProtectedState();
    user.value = nextUser;
    authLoading.value = false;
    session.value = null;
    if (nextUser) {
      const generation = requestGeneration;
      requestController = new AbortController();
      try {
        const nextSession = await portalRequest<PortalSession>(nextUser, "portalSignIn", {}, requestController.signal);
        if (!requestIsCurrent(generation, nextUser.uid)) return;
        session.value = nextSession;
        accessRevoked.value = false;
        startAccessWatch(nextUser);
        await loadView();
      } catch (error) {
        if (error instanceof PortalAccessRevokedError) await handleAccessRevoked();
        else if ((error as { name?: string }).name !== "AbortError") errorMessage.value = error instanceof Error ? error.message : "门户访问不可用";
      }
    }
  });
  refreshTimer = window.setInterval(() => { if (user.value && session.value) void loadView(); }, 60_000);
});

onBeforeUnmount(() => { stopAuth?.(); stopAccess?.(); if (refreshTimer) window.clearInterval(refreshTimer); requestController?.abort(); previewController?.abort(); errorDetailController?.abort(); });
</script>

<template>
  <div class="portal-root">
    <header class="portal-header">
      <div class="brand-lockup"><span class="brand-mark">TL</span><div><strong>美术工具使用统计</strong><span>Usage Analytics / 内部门户</span></div></div>
      <div v-if="session" class="account-strip">
        <img v-if="session.photo_url" :src="session.photo_url" alt="" class="avatar" referrerpolicy="no-referrer" />
        <span v-else class="avatar avatar-initial">{{ initials }}</span>
        <span class="account-name">{{ session.display_name }}</span>
        <span class="role-tag" :data-role="session.role">{{ session.role === "admin" ? "管理员" : "访客" }}</span>
        <button class="icon-button" type="button" title="退出门户" aria-label="退出门户" @click="logout">↗</button>
      </div>
    </header>

    <main v-if="authLoading" class="state-page"><span class="spinner" aria-hidden="true"></span><p>正在确认门户会话</p></main>
    <main v-else-if="accessRevoked" class="state-page access-revoked-page">
      <p class="eyebrow">ACCESS REVOKED</p>
      <h1>当前账号没有门户访问权限</h1>
      <p>{{ errorMessage || "请联系门户管理员确认人员状态或准入规则。" }}</p>
      <button class="login-button" type="button" @click="login"><span>G</span> 使用其他公司账号登录</button>
    </main>
    <main v-else-if="!user || !session" class="sign-in-page">
      <section class="sign-in-copy"><p class="eyebrow">TL ART TOOLS / INTERNAL</p><h1>让每一次工具运行<br /><em>都可被看见。</em></h1><p class="intro">按公司账号查看工具使用趋势、执行结果和已脱敏的异常摘要。</p><button class="login-button" type="button" @click="login"><span>G</span> 使用公司 Google 账号登录</button><p v-if="errorMessage" class="inline-error" role="alert">{{ errorMessage }}</p></section>
      <aside class="signal-panel"><div class="signal-line"><span></span><span></span><span></span></div><p class="signal-label">LIVE SIGNAL</p><strong>工具执行<br />正在被记录</strong><small>仅限已授权的公司账号访问<br />门户权限与插件登录相互独立</small></aside>
    </main>
    <main v-else class="workspace">
      <aside class="side-nav" aria-label="统计门户导航">
        <button :class="{ active: activeView === 'overview' }" type="button" @click="switchView('overview')"><span>01</span>团队概览</button>
        <button :class="{ active: activeView === 'errors' }" type="button" @click="switchView('errors')"><span>02</span>异常趋势</button>
        <button v-if="isAdmin" :class="{ active: activeView === 'principals' }" type="button" @click="switchView('principals')"><span>03</span>用户统计</button>
        <button v-if="isAdmin" :class="{ active: activeView === 'devices' }" type="button" @click="switchView('devices')"><span>04</span>设备状态</button>
        <button v-if="isAdmin" :class="{ active: activeView === 'people' }" type="button" @click="switchView('people')"><span>05</span>门户人员</button>
        <button :class="{ active: activeView === 'account' }" type="button" @click="switchView('account')"><span>06</span>我的账号</button>
        <div class="nav-foot"><span class="status-dot"></span>服务连接正常</div>
      </aside>
      <section class="content-column">
        <div class="content-heading"><div><p class="eyebrow">{{ viewEyebrow }}</p><h1>{{ viewTitle }}</h1></div><div v-if="activeView === 'overview' || activeView === 'principals' || activeView === 'errors'" class="date-filter"><label>从<input v-model="dateFrom" type="date" aria-label="开始日期" @change="loadView()" /></label><span>至</span><label><input v-model="dateTo" type="date" aria-label="结束日期" @change="loadView()" /></label></div></div>
        <div v-if="activeView === 'overview' || activeView === 'principals' || activeView === 'errors'" class="query-filter" aria-label="统计筛选">
          <label>工具<input v-model.trim="toolFilter" type="search" placeholder="全部工具" @change="loadView()" /></label>
          <label>动作<input v-model.trim="actionFilter" type="search" placeholder="全部动作" @change="loadView()" /></label>
          <label v-if="activeView === 'principals'">插件身份<input v-model.trim="principalFilter" type="search" placeholder="全部 pluginPrincipal" @change="loadView()" /></label>
          <label v-if="activeView !== 'errors'">结果<select v-model="resultFilter" @change="loadView()"><option value="">全部结果</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">取消</option><option value="interrupted">中断</option></select></label>
          <label v-if="activeView === 'errors'">错误指纹<input v-model.trim="errorFingerprintFilter" type="search" placeholder="全部指纹" @change="loadView()" /></label>
          <label v-if="activeView === 'errors'">插件版本<input v-model.trim="errorVersionFilter" type="search" placeholder="全部版本" @change="loadView()" /></label>
        </div>
        <p v-if="errorMessage" class="banner-error" role="alert">{{ errorMessage }}</p>
        <div v-if="activeView === 'overview'" class="overview-view">
          <div class="metric-row"><div><span>执行次数</span><strong>{{ totalRuns.toLocaleString() }}</strong><small>以 run_started 计</small></div><div><span>成功率</span><strong>{{ successRate }}<i>%</i></strong><small>已完成执行</small></div><div><span>失败 / 中断</span><strong>{{ totalFailures.toLocaleString() }}</strong><small>当前筛选范围</small></div></div>
          <section class="failure-trend"><div class="section-title"><h2>失败趋势</h2><span>失败与中断 / 公司日期</span></div><div class="trend-grid"><div v-for="point in failureTrend" :key="point.date" class="trend-point"><span>{{ point.date.slice(5) }}</span><div><i :style="{ width: `${Math.max(3, ((point.run_failed + point.run_interrupted) / failureTrendMax) * 100)}%` }"></i></div><strong>{{ point.run_failed + point.run_interrupted }}</strong></div><div v-if="!failureTrend.length && !loading" class="empty-trend">暂无失败记录</div></div></section>
          <section class="table-section"><div class="section-title"><h2>工具与动作</h2><span>{{ teamRows.length }} 个分组</span></div><div class="data-table"><div class="table-head"><span>工具 / 动作</span><span>执行次数</span><span>成功率</span><span>使用人数</span><span>最近使用</span></div><div v-for="row in teamRows" :key="`${row.tool_key}:${row.action_key}`" class="table-row"><span><b>{{ row.tool_key }}</b><small>{{ row.action_key }}</small></span><span>{{ row.run_started.toLocaleString() }}</span><span><strong :class="{ bad: row.run_failed > 0 }">{{ row.run_started ? Math.round((row.run_succeeded / row.run_started) * 100) : 0 }}%</strong></span><span>{{ row.distinct_users }}</span><span><b>{{ formatTime(row.last_used_at) }}</b><small>接收 {{ formatTime(row.last_received_at) }}</small><em v-if="row.time_corrected_count">已校正 {{ row.time_corrected_count }} 条</em></span></div><div v-if="!teamRows.length && !loading" class="empty-row">当前时间范围没有可展示的执行记录</div></div></section>
        </div>
        <section v-else-if="activeView === 'principals'" class="table-section report-view"><div class="section-title"><h2>插件人员使用明细</h2><span>按不可变插件身份分别统计</span></div><div class="data-table principal-table"><div class="table-head"><span>插件人员</span><span>工具 / 动作</span><span>执行次数</span><span>成功率</span><span>最近使用</span></div><div v-for="row in principalRows" :key="`${row.plugin_principal_id}:${row.tool_key}:${row.action_key}`" class="table-row"><span><b>{{ row.display_name }}</b><small>{{ row.email || '资料邮箱未提供' }}</small><em v-if="principalIdentityChanged(row)" class="identity-warning">身份已变化</em><em v-else>资料更新于 {{ formatTime(row.profile_updated_at) }}</em></span><span><b>{{ row.tool_key }}</b><small>{{ row.action_key }}</small></span><span><b>{{ row.run_started.toLocaleString() }}</b><small>使用趋势</small><span class="principal-trend" role="img" :aria-label="principalTrendLabel(row)"><i v-for="point in visiblePrincipalTrend(row)" :key="point.date" :class="{ bad: point.run_failed + point.run_interrupted > 0 }" :style="{ height: `${Math.max(18, (point.run_started / principalTrendMax(row)) * 100)}%` }" :title="`${point.date} · ${point.run_started} 次`"></i></span></span><span><strong :class="{ bad: row.run_failed + row.run_interrupted > 0 }">{{ row.run_started ? Math.round((row.run_succeeded / row.run_started) * 100) : 0 }}%</strong></span><span><b>{{ formatTime(row.last_used_at) }}</b><small>接收 {{ formatTime(row.last_received_at) }}</small><em v-if="row.time_corrected_count">已校正 {{ row.time_corrected_count }} 条</em></span></div><div v-if="!principalRows.length && !loading" class="empty-row">当前时间范围没有插件人员使用记录</div></div></section>
        <section v-else-if="activeView === 'devices'" class="table-section report-view"><div class="section-title"><h2>插件设备只读状态</h2><span>此页面不能撤销设备或租约</span></div><div class="data-table device-table"><div class="table-head"><span>插件身份</span><span>状态</span><span>绑定时间</span><span>最近验证</span><span>撤销时间</span></div><div v-for="row in deviceRows" :key="row.binding_id" class="table-row"><span><b>{{ row.plugin_principal_id }}</b><small>绑定 {{ row.binding_id.slice(0, 12) }}</small></span><span><mark :data-status="row.status">{{ row.status === 'active' ? '有效' : '已撤销' }}</mark></span><span>{{ formatTime(row.created_at) }}</span><span>{{ formatTime(row.last_seen_at) }}</span><span>{{ formatTime(row.revoked_at) }}</span></div><div v-if="!deviceRows.length && !loading" class="empty-row">暂无插件设备记录</div></div></section>
        <section v-else-if="activeView === 'errors'" class="table-section">
          <div class="section-title"><h2>脱敏异常摘要</h2><span>不显示原始日志</span></div>
          <div class="data-table error-table">
            <div class="table-head"><span>工具 / 动作</span><span>类别</span><span>次数</span><span>最近发生</span><span>状态</span></div>
            <div v-for="row in errorRows" :key="`${row.tool_key}:${row.action_key}:${row.fingerprint}`" class="table-row">
              <span><b>{{ row.tool_key }}</b><small>{{ row.action_key }}</small><code class="error-fingerprint" :title="row.fingerprint" :aria-label="`错误指纹 ${row.fingerprint}`">{{ row.fingerprint.slice(0, 12) }}</code><em>{{ row.summaries[0]?.summary || '已脱敏摘要' }}</em><em>{{ row.affected_versions.length ? row.affected_versions.join(' / ') : '版本未记录' }}</em></span>
              <span>{{ row.error_category }}</span>
              <span>{{ row.count }}</span>
              <span><b>{{ formatTime(row.recent_seen_at) }}</b><small>首次 {{ formatTime(row.first_seen_at) }}</small><em>接收 {{ formatTime(row.recent_received_at) }}</em><em v-if="row.time_corrected_count">已校正 {{ row.time_corrected_count }} 条</em></span>
              <span class="error-row-status"><mark :data-status="row.status">{{ row.status === 'open' ? '处理中' : '已解决' }}</mark><button v-if="isAdmin" type="button" @click="openErrorDetails(row)">查看关联用户与设备</button></span>
            </div>
            <div v-if="!errorRows.length && !loading" class="empty-row">当前时间范围没有异常记录</div>
          </div>
          <section v-if="isAdmin && selectedError" class="error-detail-panel" aria-label="异常关联用户与设备">
            <div class="section-title"><h2>关联用户与设备</h2><span>仅显示已脱敏事件字段</span></div>
            <div class="data-table error-detail-table">
              <div class="table-head"><span>用户</span><span>插件身份</span><span>设备绑定</span><span>版本 / 事件</span><span>发生 / 接收</span></div>
              <div v-for="detail in errorDetailRows" :key="detail.event_id" class="table-row"><span><b>{{ detail.display_name }}</b><small>{{ detail.email || '邮箱未提供' }}</small></span><span>{{ detail.plugin_principal_id }}</span><span>{{ detail.binding_id || '未记录' }}</span><span><b>{{ detail.plugin_version }}</b><small>{{ detail.event_type }}</small></span><span><b>{{ formatTime(detail.observed_at) }}</b><small>接收 {{ formatTime(detail.received_at) }}</small></span></div>
              <div v-if="!errorDetailRows.length && !errorDetailLoading" class="empty-row">当前异常没有可展示的关联记录</div>
            </div>
            <button v-if="errorDetailCursor" class="load-more" type="button" :disabled="errorDetailLoading" @click="loadErrorDetails(selectedError!, true)">加载更多关联记录</button>
          </section>
        </section>
        <section v-else-if="activeView === 'account'" class="account-view"><div class="account-card"><img v-if="session.photo_url" :src="session.photo_url" alt="" class="large-avatar" referrerpolicy="no-referrer" /><div v-else class="large-avatar">{{ initials }}</div><div><p class="eyebrow">PORTAL IDENTITY</p><h2>{{ session.display_name }}</h2><p>{{ session.email }}</p></div></div><dl><div><dt>门户角色</dt><dd>{{ session.role === 'admin' ? '管理员' : '访客' }}</dd></div><div><dt>首次登录</dt><dd>{{ formatTime(session.first_login_at) }}</dd></div><div><dt>最近登录</dt><dd>{{ formatTime(session.last_login_at) }}</dd></div><div><dt>登录来源</dt><dd>公司 Google 账号</dd></div></dl><p class="account-note">门户身份只用于查看统计网页，不会创建、续租或撤销插件账号。</p></section>
        <section v-else class="people-view">
          <div class="policy-editor"><div><p class="eyebrow">PRE-AUTHORIZATION</p><h2>增加门户准入</h2></div><select v-model="policyKind" aria-label="准入类型"><option value="email">公司邮箱</option><option value="domain">公司域名</option></select><input v-model="policyValue" :placeholder="policyKind === 'email' ? 'name@xindong.com' : 'xindong.com'" aria-label="准入值" /><select v-model="policyRole" :disabled="policyKind === 'domain'" aria-label="门户角色"><option value="visitor">访客</option><option value="admin">管理员</option></select><button type="button" @click="savePolicy">保存准入</button></div>
          <div class="policy-list"><div v-for="policy in policies" :key="policy.policy_id" class="policy-row"><span><b>{{ policy.kind === 'email' ? '邮箱' : '域名' }}</b>{{ policy.normalized_value }} · {{ policy.role === 'admin' ? '管理员' : '访客' }}</span><label class="policy-toggle"><input type="checkbox" :checked="policy.enabled" :aria-label="`${policy.enabled ? '停用' : '启用'} ${policy.normalized_value}`" @click.prevent.stop="togglePolicy(policy)" /><span>{{ policy.enabled ? '启用' : '停用' }}</span></label></div></div>
          <div class="policy-preview"><div><p class="eyebrow">EFFECTIVE ACCESS</p><h2>预览最终生效身份</h2></div><label>公司邮箱<input v-model.trim="policyPreviewEmail" type="email" placeholder="name@xindong.com" @keyup.enter="previewPolicy" /></label><button type="button" :disabled="policyPreviewLoading || !policyPreviewEmail" @click="previewPolicy">{{ policyPreviewLoading ? '检查中' : '检查身份' }}</button><div class="policy-preview-result" role="status" aria-live="polite"><template v-if="policyPreview"><strong>{{ policyPreview.access === 'granted' ? (policyPreview.role === 'admin' ? '管理员' : '访客') : '未授权' }}</strong><span v-if="policyPreview.matched_by === 'email'">命中邮箱规则，邮箱规则优先</span><span v-else-if="policyPreview.matched_by === 'domain'">命中公司域名默认规则</span><span v-else>未命中启用的准入规则</span></template><span v-else>邮箱规则优先于域名规则</span></div></div>
          <section class="table-section"><div class="section-title"><h2>门户访问人员</h2><label class="table-search">搜索<input v-model.trim="peopleSearch" type="search" placeholder="姓名或公司邮箱" @change="loadView()" /></label></div><div class="data-table people-table"><div class="table-head"><span>人员</span><span>角色</span><span>状态</span><span>首次登录</span><span>最近登录</span><span>操作</span></div><div v-for="person in people" :key="person.uid" class="table-row"><span class="person-identity"><img v-if="person.photo_url" :src="person.photo_url" alt="" class="person-avatar" referrerpolicy="no-referrer" /><i v-else class="person-avatar person-initial">{{ personInitials(person) }}</i><span><b>{{ person.display_name }}</b><small>{{ person.normalized_email }}</small></span></span><span>{{ person.role === 'admin' ? '管理员' : '访客' }}</span><span><mark :data-status="person.status">{{ person.status === 'active' ? '启用' : person.status === 'disabled' ? '已禁用' : '已移除' }}</mark></span><span>{{ formatTime(person.first_login_at) }}</span><span>{{ formatTime(person.last_login_at) }}</span><span class="row-actions"><button v-if="person.role === 'visitor'" :disabled="person.uid === session.uid" type="button" title="设为管理员" @click="changePerson(person, { role: 'admin' })">管理员</button><button v-else :disabled="person.uid === session.uid" type="button" title="设为访客" @click="changePerson(person, { role: 'visitor' })">访客</button><button v-if="person.status !== 'active'" :disabled="person.uid === session.uid" type="button" title="恢复访问" @click="changePerson(person, { status: 'active' })">恢复</button><button v-else :disabled="person.uid === session.uid" type="button" title="禁用访问" @click="changePerson(person, { status: 'disabled' })">禁用</button><button :disabled="person.uid === session.uid" type="button" title="移除访问" @click="changePerson(person, { status: 'removed' })">移除</button></span></div><div v-if="!people.length && !loading" class="empty-row">暂无门户人员</div></div></section>
        </section>
        <button v-if="hasMore" class="load-more" type="button" :disabled="loading" @click="loadMore">加载更多</button>
        <div v-if="loading" class="loading-bar"><span></span></div>
      </section>
    </main>
  </div>
</template>
