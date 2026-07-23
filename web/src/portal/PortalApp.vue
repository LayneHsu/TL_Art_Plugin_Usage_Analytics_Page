<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { User } from "firebase/auth";
import { aggregateUsage, filterErrorLogs, toExportRecords } from "./analytics";
import { sessionFromFirebaseUser, type PortalData, type PortalMember, type PortalRole, type PortalSession, type UsageFilter } from "./api";
import { isPortalEmail, signInPortal, signOutPortal, watchPortalMember, watchPortalUser } from "./firebase";
import {
  deleteRecordsBefore,
  loadPortalData,
  loadPortalMembers,
  previewCleanup,
  removePortalMember,
  savePortalMember,
  updatePortalMember,
  type CleanupPreview,
} from "./store";

type PortalView = "overview" | "users" | "tools" | "events" | "errors" | "members" | "data" | "account";

const emptyData = (): PortalData => ({ profiles: [], shards: [], errors: [] });
const user = ref<User | null>(null);
const session = ref<PortalSession | null>(null);
const currentMember = ref<PortalMember | null>(null);
const portalData = ref<PortalData>(emptyData());
const members = ref<PortalMember[]>([]);
const activeView = ref<PortalView>("overview");
const authLoading = ref(true);
const loading = ref(false);
const accessDenied = ref(false);
const errorMessage = ref("");
const operationMessage = ref("");
const dateFrom = ref(companyDate(-29));
const dateTo = ref(companyDate());
const userFilter = ref("");
const toolFilter = ref("");
const actionFilter = ref("");
const resultFilter = ref("");
const memberEmail = ref("");
const memberRole = ref<PortalRole>("viewer");
const cleanupBefore = ref(companyDate(-90));
const cleanupState = ref<CleanupPreview | null>(null);
const DAILY_OPERATION_WARNING = 5_000;
const connectionState = ref<"connecting" | "connected" | "error">("connecting");

let stopAuth: (() => void) | undefined;
let stopMember: (() => void) | undefined;
let refreshTimer: number | undefined;
let controller: AbortController | undefined;
let requestGeneration = 0;

const isAdmin = computed(() => session.value?.role === "admin");
const initials = computed(() => (session.value?.display_name || session.value?.email || "?").slice(0, 1).toUpperCase());
const filter = computed<UsageFilter>(() => ({
  dateFrom: dateFrom.value,
  dateTo: dateTo.value,
  userUid: userFilter.value || undefined,
  toolKey: toolFilter.value.trim() || undefined,
  actionKey: actionFilter.value.trim() || undefined,
  result: resultFilter.value || undefined,
}));
const analytics = computed(() => aggregateUsage(portalData.value.shards, portalData.value.profiles, filter.value, portalData.value.errors));
const filteredErrorLogs = computed(() => filterErrorLogs(portalData.value.errors, filter.value).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
const successRate = computed(() => analytics.value.total ? Math.round((analytics.value.succeeded / analytics.value.total) * 100) : 0);
const quotaPercent = computed(() => Math.min(100, Math.round((analytics.value.total / DAILY_OPERATION_WARNING) * 100)));
const trendMaximum = computed(() => Math.max(1, ...analytics.value.dailyTrend.map((point) => point.total)));
const viewTitle = computed(() => ({
  overview: "使用概览",
  users: "用户统计",
  tools: "工具统计",
  events: "使用明细",
  errors: "异常日志",
  members: "成员管理",
  data: "数据管理",
  account: "我的账号",
})[activeView.value]);
const viewEyebrow = computed(() => ({
  overview: "DAILY SIGNAL",
  users: "PEOPLE",
  tools: "TOOLS",
  events: "EVENTS",
  errors: "ERRORS",
  members: "ACCESS",
  data: "RETENTION",
  account: "ACCOUNT",
})[activeView.value]);

function companyDate(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(date);
}

function formatDuration(value?: number): string {
  if (value === undefined) return "-";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function resultLabel(value: string): string {
  return ({ started: "开始", succeeded: "成功", failed: "失败", rejected: "拒绝", cancelled: "取消", interrupted: "中断", unexpected: "异常" } as Record<string, string>)[value] || value;
}

function clearProtectedState(): void {
  requestGeneration += 1;
  controller?.abort();
  controller = undefined;
  portalData.value = emptyData();
  members.value = [];
  cleanupState.value = null;
  loading.value = false;
  operationMessage.value = "";
  connectionState.value = "connecting";
}

function requestIsCurrent(generation: number, uid: string): boolean {
  return generation === requestGeneration && user.value?.uid === uid && currentMember.value?.enabled === true;
}

async function loadData(): Promise<void> {
  if (!user.value || !currentMember.value?.enabled) return;
  const currentUser = user.value;
  const generation = ++requestGeneration;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  errorMessage.value = "";
  try {
    const [data, memberRows] = await Promise.all([
      loadPortalData(dateFrom.value, dateTo.value, controller.signal),
      currentMember.value.role === "admin" ? loadPortalMembers(controller.signal) : Promise.resolve([]),
    ]);
    if (!requestIsCurrent(generation, currentUser.uid)) return;
    portalData.value = data;
    members.value = memberRows;
    connectionState.value = "connected";
  } catch (error) {
    if ((error as { name?: string }).name !== "AbortError") {
      errorMessage.value = error instanceof Error ? error.message : "统计数据读取失败";
      connectionState.value = "error";
    }
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}

async function refreshMembers(): Promise<void> {
  if (!isAdmin.value) return;
  members.value = await loadPortalMembers();
}

function startMemberWatch(currentUser: User): void {
  stopMember?.();
  stopMember = watchPortalMember(currentUser, (member) => {
    if (user.value?.uid !== currentUser.uid) return;
    clearProtectedState();
    currentMember.value = member;
    if (!member?.enabled) {
      session.value = null;
      accessDenied.value = true;
      activeView.value = "overview";
      return;
    }
    const previousRole = session.value?.role;
    session.value = sessionFromFirebaseUser(currentUser, member);
    accessDenied.value = false;
    if (previousRole === "admin" && member.role === "viewer" && ["members", "data"].includes(activeView.value)) {
      activeView.value = "overview";
    }
    void loadData();
  }, (error) => {
    clearProtectedState();
    session.value = null;
    currentMember.value = null;
    accessDenied.value = true;
    errorMessage.value = error.message || "无法确认当前账号的查看权限";
  });
}

async function login(): Promise<void> {
  accessDenied.value = false;
  errorMessage.value = "";
  try {
    if (user.value) await signOutPortal();
    await signInPortal();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录未完成";
  }
}

async function logout(): Promise<void> {
  stopMember?.();
  stopMember = undefined;
  clearProtectedState();
  session.value = null;
  currentMember.value = null;
  accessDenied.value = false;
  activeView.value = "overview";
  await signOutPortal();
}

function switchView(view: PortalView): void {
  if (!isAdmin.value && ["members", "data"].includes(view)) return;
  activeView.value = view;
  operationMessage.value = "";
}

async function addMember(): Promise<void> {
  if (!user.value || !isAdmin.value || !memberEmail.value.trim()) return;
  const email = memberEmail.value.trim().toLowerCase();
  if (!window.confirm(`确认增加 ${email} 为${memberRole.value === "admin" ? "管理员" : "查看者"}？`)) return;
  try {
    await savePortalMember(user.value, email, memberRole.value);
    memberEmail.value = "";
    await refreshMembers();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "成员保存失败";
  }
}

async function changeMember(member: PortalMember, changes: { role?: PortalRole; enabled?: boolean }): Promise<void> {
  if (!user.value || !isAdmin.value) return;
  if (!window.confirm(`确认修改 ${member.email} 的网页权限？`)) return;
  try {
    await updatePortalMember(user.value, member, changes);
    await refreshMembers();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "成员更新失败";
  }
}

async function removeMember(member: PortalMember): Promise<void> {
  if (!user.value || !isAdmin.value) return;
  if (!window.confirm(`确认移除 ${member.email}？此操作不会删除该用户的统计数据。`)) return;
  try {
    await removePortalMember(user.value, member);
    await refreshMembers();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "成员移除失败";
  }
}

function csvText<T extends object>(rows: T[]): string {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]) as Array<keyof T>;
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.map(escape).join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n");
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportJson(): void {
  download(`tl-art-usage-${dateFrom.value}-${dateTo.value}.json`, JSON.stringify({ events: toExportRecords(analytics.value), errors: filteredErrorLogs.value }, null, 2), "application/json");
}

function exportEventsCsv(): void {
  download(`tl-art-events-${dateFrom.value}-${dateTo.value}.csv`, csvText(toExportRecords(analytics.value)), "text/csv;charset=utf-8");
}

function exportErrorsCsv(): void {
  download(`tl-art-errors-${dateFrom.value}-${dateTo.value}.csv`, csvText(filteredErrorLogs.value), "text/csv;charset=utf-8");
}

async function inspectCleanup(): Promise<void> {
  if (!isAdmin.value) return;
  try {
    cleanupState.value = await previewCleanup(cleanupBefore.value);
    operationMessage.value = "";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "无法统计待清理文档";
  }
}

async function runCleanup(): Promise<void> {
  if (!isAdmin.value || !cleanupState.value) return;
  const total = cleanupState.value.usageDocuments + cleanupState.value.errorDocuments;
  if (!window.confirm(`确认永久删除 ${cleanupBefore.value} 之前的 ${total}${cleanupState.value.truncated ? "+" : ""} 个统计文档？`)) return;
  try {
    const result = await deleteRecordsBefore(cleanupBefore.value);
    await inspectCleanup();
    await loadData();
    operationMessage.value = result.remaining ? `已删除 ${result.deleted} 个文档，仍有数据可继续清理` : `已删除 ${result.deleted} 个文档`;
  } catch (error) {
    operationMessage.value = "清理未完成，可保留当前截止日期后重试";
    errorMessage.value = error instanceof Error ? error.message : "清理失败";
  }
}

onMounted(() => {
  stopAuth = watchPortalUser((nextUser) => {
    stopMember?.();
    stopMember = undefined;
    clearProtectedState();
    user.value = nextUser;
    session.value = null;
    currentMember.value = null;
    authLoading.value = false;
    if (!nextUser) return;
    if (!nextUser.email || !isPortalEmail(nextUser.email)) {
      accessDenied.value = true;
      errorMessage.value = "当前账号未获授权访问统计网页";
      return;
    }
    startMemberWatch(nextUser);
  });
  refreshTimer = window.setInterval(() => { if (session.value) void loadData(); }, 60_000);
});

onBeforeUnmount(() => {
  stopAuth?.();
  stopMember?.();
  controller?.abort();
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="portal-root">
    <header class="portal-header">
      <div class="brand-lockup"><span class="brand-mark">TL</span><div><strong>美术工具使用统计</strong><span>Usage Analytics</span></div></div>
      <div v-if="session" class="account-strip">
        <img v-if="session.photo_url" :src="session.photo_url" alt="" class="avatar" referrerpolicy="no-referrer" />
        <span v-else class="avatar avatar-initial">{{ initials }}</span>
        <span class="account-name">{{ session.display_name }}</span>
        <span class="role-tag" :data-role="session.role">{{ session.role === "admin" ? "管理员" : "查看者" }}</span>
        <button class="icon-button" type="button" title="退出登录" aria-label="退出登录" @click="logout">↗</button>
      </div>
    </header>

    <main v-if="authLoading" class="state-page"><span class="spinner" aria-hidden="true"></span><p>正在确认账号</p></main>
    <main v-else-if="accessDenied" class="state-page access-revoked-page">
      <p class="eyebrow">ACCESS DENIED</p><h1>当前账号没有查看权限</h1><p>{{ errorMessage || "请联系管理员增加网页成员。" }}</p>
      <button class="login-button" type="button" @click="login"><span>G</span> 使用其他公司账号</button>
    </main>
    <main v-else-if="!user || !session" class="sign-in-page">
      <section class="sign-in-copy"><p class="eyebrow">TL ART TOOLS / INTERNAL</p><h1>美术工具<br /><em>使用统计</em></h1><p class="intro">公司内部统计入口</p><button class="login-button" type="button" @click="login"><span>G</span> 使用公司 Google 账号登录</button><p v-if="errorMessage" class="inline-error" role="alert">{{ errorMessage }}</p></section>
      <aside class="signal-panel"><div class="signal-line"><span></span><span></span><span></span></div><p class="signal-label">DAILY SIGNAL</p><strong>{{ DAILY_OPERATION_WARNING.toLocaleString() }}</strong><small>每日工具操作安全工作线</small></aside>
    </main>
    <main v-else class="workspace">
      <aside class="side-nav" aria-label="统计导航">
        <button :class="{ active: activeView === 'overview' }" type="button" @click="switchView('overview')"><span>01</span>使用概览</button>
        <button :class="{ active: activeView === 'users' }" type="button" @click="switchView('users')"><span>02</span>用户统计</button>
        <button :class="{ active: activeView === 'tools' }" type="button" @click="switchView('tools')"><span>03</span>工具统计</button>
        <button :class="{ active: activeView === 'events' }" type="button" @click="switchView('events')"><span>04</span>使用明细</button>
        <button :class="{ active: activeView === 'errors' }" type="button" @click="switchView('errors')"><span>05</span>异常日志</button>
        <button v-if="isAdmin" :class="{ active: activeView === 'members' }" type="button" @click="switchView('members')"><span>06</span>成员管理</button>
        <button v-if="isAdmin" :class="{ active: activeView === 'data' }" type="button" @click="switchView('data')"><span>07</span>数据管理</button>
        <button :class="{ active: activeView === 'account' }" type="button" @click="switchView('account')"><span>08</span>我的账号</button>
        <div class="nav-foot"><span class="status-dot" :data-state="connectionState"></span>{{ connectionState === "connected" ? "Firestore 已连接" : connectionState === "error" ? "Firestore 连接异常" : "正在连接 Firestore" }}</div>
      </aside>

      <section class="content-column">
        <div class="content-heading"><div><p class="eyebrow">{{ viewEyebrow }}</p><h1>{{ viewTitle }}</h1></div><div v-if="!['members', 'data', 'account'].includes(activeView)" class="date-filter"><label>从<input v-model="dateFrom" type="date" aria-label="开始日期" @change="loadData" /></label><span>至</span><label><input v-model="dateTo" type="date" aria-label="结束日期" @change="loadData" /></label></div></div>
        <div v-if="!['members', 'data', 'account'].includes(activeView)" class="query-filter" aria-label="统计筛选">
          <label>用户<select v-model="userFilter"><option value="">全部用户</option><option v-for="profile in portalData.profiles" :key="profile.uid" :value="profile.uid">{{ profile.display_name }} · {{ profile.email }}</option></select></label>
          <label>工具<input v-model.trim="toolFilter" type="search" placeholder="全部工具" /></label>
          <label>动作<input v-model.trim="actionFilter" type="search" placeholder="全部动作" /></label>
          <label>结果<select v-model="resultFilter"><option value="">全部结果</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">取消</option><option value="interrupted">中断</option></select></label>
        </div>
        <p v-if="errorMessage" class="banner-error" role="alert">{{ errorMessage }}</p>

        <div v-if="activeView === 'overview'" class="overview-view">
          <div class="metric-row metric-row-wide">
            <div><span>使用次数</span><strong>{{ analytics.total.toLocaleString() }}</strong><small>每次 run_started 去重计数</small></div>
            <div><span>活跃用户</span><strong>{{ analytics.activeUsers }}</strong><small>当前筛选范围</small></div>
            <div><span>活跃工具</span><strong>{{ analytics.activeTools }}</strong><small>稳定工具 key</small></div>
            <div><span>成功率</span><strong>{{ successRate }}<i>%</i></strong><small>{{ analytics.failed }} 次失败</small></div>
          </div>
          <section class="quota-band"><div><p class="eyebrow">SPARK DAILY BUDGET</p><h2>{{ DAILY_OPERATION_WARNING.toLocaleString() }} 次安全工作线</h2></div><div class="quota-track"><i :style="{ width: `${quotaPercent}%` }"></i></div><strong>{{ quotaPercent }}%</strong></section>
          <section class="failure-trend"><div class="section-title"><h2>每日趋势</h2><span>使用次数 / 公司日期</span></div><div class="trend-grid"><div v-for="point in analytics.dailyTrend" :key="point.date" class="trend-point"><span>{{ point.date.slice(5) }}</span><div><i :class="{ bad: point.failed > 0 }" :style="{ width: `${Math.max(3, (point.total / trendMaximum) * 100)}%` }"></i></div><strong>{{ point.total }}</strong></div><div v-if="!analytics.dailyTrend.length && !loading" class="empty-trend">暂无使用记录</div></div></section>
          <section class="table-section"><div class="section-title"><h2>工具摘要</h2><span>{{ analytics.usageRows.length }} 个分组</span></div><div class="data-table"><div class="table-head"><span>工具 / 动作</span><span>使用次数</span><span>成功率</span><span>用户数</span><span>最近使用</span></div><div v-for="row in analytics.usageRows" :key="`overview-${row.tool_key}:${row.action_key}`" class="table-row"><span><b>{{ row.tool_key }}</b><small>{{ row.action_key }}</small></span><span>{{ row.total }}</span><span><strong :class="{ bad: row.failed + row.interrupted }">{{ row.total ? Math.round((row.succeeded / row.total) * 100) : 0 }}%</strong></span><span>{{ row.users }}</span><span>{{ formatTime(row.last_occurred_at) }}</span></div><div v-if="!analytics.usageRows.length && !loading" class="empty-row">暂无工具记录</div></div></section>
        </div>

        <section v-else-if="activeView === 'users'" class="table-section report-view">
          <div class="section-title"><h2>用户使用情况</h2><span>{{ analytics.userRows.length }} 人</span></div>
          <div class="data-table user-table"><div class="table-head"><span>用户</span><span>使用次数</span><span>成功</span><span>失败</span><span>最近使用</span></div><div v-for="row in analytics.userRows" :key="row.uid" class="table-row"><span><b>{{ row.display_name }}</b><small>{{ row.email }}</small></span><span>{{ row.total }}</span><span><strong>{{ row.succeeded }}</strong></span><span><strong :class="{ bad: row.failed }">{{ row.failed }}</strong></span><span>{{ formatTime(row.last_occurred_at) }}</span></div><div v-if="!analytics.userRows.length && !loading" class="empty-row">暂无用户记录</div></div>
        </section>

        <section v-else-if="activeView === 'tools'" class="table-section report-view">
          <div class="section-title"><h2>工具与动作</h2><span>{{ analytics.usageRows.length }} 个分组</span></div>
          <div class="data-table"><div class="table-head"><span>工具 / 动作</span><span>使用次数</span><span>成功率</span><span>用户数</span><span>最近使用</span></div><div v-for="row in analytics.usageRows" :key="`${row.tool_key}:${row.action_key}`" class="table-row"><span><b>{{ row.tool_key }}</b><small>{{ row.action_key }}</small></span><span>{{ row.total }}</span><span><strong :class="{ bad: row.failed + row.interrupted }">{{ row.total ? Math.round((row.succeeded / row.total) * 100) : 0 }}%</strong></span><span>{{ row.users }}</span><span>{{ formatTime(row.last_occurred_at) }}</span></div><div v-if="!analytics.usageRows.length && !loading" class="empty-row">暂无工具记录</div></div>
        </section>

          <section v-else-if="activeView === 'events'" class="table-section report-view">
          <div class="section-title"><h2>每次工具使用</h2><span>{{ analytics.events.length }} 条</span></div>
          <div class="data-table event-table"><div class="table-head"><span>用户</span><span>工具 / 动作</span><span>准确时间</span><span>结果</span><span>耗时</span></div><div v-for="event in analytics.events" :key="`${event.uid}:${event.event_id}`" class="table-row"><span><b>{{ event.display_name }}</b><small>{{ event.email }}</small></span><span><b>{{ event.tool_key }}</b><small>{{ event.action_key }}</small></span><span>{{ formatTime(event.occurred_at) }}</span><span><mark :data-status="event.result">{{ resultLabel(event.result) }}</mark></span><span>{{ formatDuration(event.duration_ms) }}</span></div><div v-if="!analytics.events.length && !loading" class="empty-row">暂无使用明细</div></div>
        </section>

        <section v-else-if="activeView === 'errors'" class="table-section report-view">
          <div class="section-title"><h2>脱敏异常日志</h2><span>{{ filteredErrorLogs.length }} 条</span></div>
          <div class="data-table error-log-table"><div class="table-head"><span>工具 / 动作</span><span>用户</span><span>类型</span><span>时间</span><span>摘要与堆栈</span></div><div v-for="log in filteredErrorLogs" :key="`${log.uid}:${log.event_id}`" class="table-row"><span><b>{{ log.tool_key }}</b><small>{{ log.action_key }}</small><code class="error-fingerprint" :title="log.fingerprint">{{ log.fingerprint.slice(0, 12) }}</code></span><span>{{ portalData.profiles.find((profile) => profile.uid === log.uid)?.display_name || log.uid }}</span><span>{{ log.error_type }}</span><span>{{ formatTime(log.occurred_at) }}</span><span><b>{{ log.summary }}</b><details><summary>查看堆栈</summary><pre>{{ log.stack }}</pre></details></span></div><div v-if="!filteredErrorLogs.length && !loading" class="empty-row">暂无异常日志</div></div>
        </section>

        <section v-else-if="activeView === 'members' && isAdmin" class="people-view">
          <div class="policy-editor"><div><p class="eyebrow">PORTAL MEMBERS</p><h2>增加网页成员</h2></div><input v-model.trim="memberEmail" type="email" placeholder="name@xindong.com" aria-label="成员邮箱" /><select v-model="memberRole" aria-label="成员身份"><option value="viewer">查看者</option><option value="admin">管理员</option></select><button type="button" @click="addMember">增加成员</button></div>
          <section class="table-section"><div class="section-title"><h2>成员管理</h2><span>{{ members.length }} 人</span></div><div class="data-table member-table"><div class="table-head"><span>门户邮箱</span><span>身份</span><span>状态</span><span>更新时间</span><span>操作</span></div><div v-for="member in members" :key="member.email" class="table-row"><span><b>{{ member.email }}</b><small>{{ member.created_by }}</small></span><span>{{ member.role === 'admin' ? '管理员' : '查看者' }}</span><span><mark :data-status="member.enabled ? 'succeeded' : 'disabled'">{{ member.enabled ? '启用' : '禁用' }}</mark></span><span>{{ formatTime(member.updated_at) }}</span><span class="row-actions"><button :disabled="member.email === session.email" type="button" @click="changeMember(member, { role: member.role === 'admin' ? 'viewer' : 'admin' })">{{ member.role === 'admin' ? '设为查看者' : '设为管理员' }}</button><button :disabled="member.email === session.email" type="button" @click="changeMember(member, { enabled: !member.enabled })">{{ member.enabled ? '禁用' : '恢复' }}</button><button :disabled="member.email === session.email" type="button" @click="removeMember(member)">移除</button></span></div></div></section>
        </section>

        <section v-else-if="activeView === 'data' && isAdmin" class="data-management-view">
          <div class="export-band"><div><p class="eyebrow">EXPORT</p><h2>导出当前筛选数据</h2></div><button type="button" @click="exportJson">导出 JSON</button><button type="button" @click="exportEventsCsv">导出事件 CSV</button><button type="button" @click="exportErrorsCsv">导出异常 CSV</button></div>
          <div class="cleanup-band"><div><p class="eyebrow">MANUAL CLEANUP</p><h2>按日期清理旧数据</h2></div><label>删除此日期之前<input v-model="cleanupBefore" type="date" aria-label="清理截止日期" @change="cleanupState = null" /></label><button type="button" @click="inspectCleanup">检查数量</button><button class="danger-button" type="button" :disabled="!cleanupState" @click="runCleanup">确认清理</button></div>
          <div v-if="cleanupState" class="cleanup-summary"><strong>{{ cleanupState.usageDocuments + cleanupState.errorDocuments }}{{ cleanupState.truncated ? '+' : '' }}</strong><span>个待删除文档 · 使用分片 {{ cleanupState.usageDocuments }} · 异常 {{ cleanupState.errorDocuments }}</span></div><p v-if="operationMessage" class="account-note">{{ operationMessage }}</p>
        </section>

        <section v-else-if="activeView === 'account'" class="account-view"><div class="account-card"><img v-if="session.photo_url" :src="session.photo_url" alt="" class="large-avatar" referrerpolicy="no-referrer" /><div v-else class="large-avatar">{{ initials }}</div><div><p class="eyebrow">PORTAL IDENTITY</p><h2>{{ session.display_name }}</h2><p>{{ session.email }}</p></div></div><dl><div><dt>网页身份</dt><dd>{{ session.role === 'admin' ? '管理员' : '查看者' }}</dd></div><div><dt>账号来源</dt><dd>Google 账号</dd></div><div><dt>权限文档</dt><dd>portalMembers/{{ session.email }}</dd></div></dl></section>

        <div v-if="loading" class="loading-bar"><span></span></div>
      </section>
    </main>
  </div>
</template>
