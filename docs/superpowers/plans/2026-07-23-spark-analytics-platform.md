# Spark Analytics Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. This plan intentionally contains no example implementation code, following the project owner's documentation preference.

**Goal:** 把 `TL_Art_Tool_Usage_Analytics` 从 Functions/Secret Manager 企业级平台改为个人 Firebase Spark 可部署的 Firestore 直连统计网页。

**Architecture:** GitHub Pages 托管 Vue 统计网页，Firebase Authentication 提供 Google 登录，Cloud Firestore 保存插件用户、每日事件分桶、错误日志和门户成员。Firestore Rules 直接区分普通插件用户、查看者和管理员，不保留任何可信服务端组件。

**Tech Stack:** Vue 3、TypeScript、Vite、Firebase Web SDK、Cloud Firestore Rules、Firestore Emulator、Playwright、GitHub Pages。

---

### Task 1: 建立轻量架构回归门禁

**Files:**
- Modify: `package.json`
- Modify: `tests/structure.contract.test.mjs`
- Modify: `tests/environment.contract.test.mjs`
- Modify: `tests/contracts/repository-contract.test.mjs`
- Delete: `tests/contracts/firebase-secret-sync.test.mjs`
- Delete: `tests/contracts/plugin-auth-production.contract.test.mjs`
- Delete: `tests/web/plugin-pairing-page.contract.test.mjs`
- Create: `tests/contracts/spark-architecture.contract.test.mjs`

- [ ] 把根工作区改为只包含 `web`，移除所有 Functions build、plugin-auth、usage ingestion、Functions emulator 和 Secret Manager 测试命令。
- [ ] 新增 Spark 架构合同，强制仓库不存在 `functions/`、Functions 部署、Secret Manager、Cloud Scheduler、租约和浏览器配对运行时代码。
- [ ] 保留 Web build、Pages artifact、Firestore Rules、跨仓工具注册表和 Playwright 验证入口。
- [ ] 先运行新合同并确认它能识别当前旧架构，再进入删除任务。

### Task 2: 删除非 Spark 后端和旧企业级合同

**Files:**
- Delete: `functions/`
- Delete: `config/firebase-runtime-parameters.json`
- Delete: `scripts/sync-firebase-secrets.mjs`
- Delete: `scripts/validate-firebase-runtime-config.mjs`
- Delete: `contracts/plugin-auth-contract.md`
- Delete: `contracts/auth-domain-boundaries.md`
- Replace: `contracts/error-redaction.md`
- Delete: `docs/plugin-auth-operations.md`
- Delete: `docs/usage-ingestion.md`
- Delete: `docs/usage-operations.md`
- Replace: `docs/dependency-security.md`
- Delete: `.github/workflows/deploy-firebase.yml`
- Modify: `firebase.json`
- Modify: `package-lock.json`

- [ ] 删除 Functions 源码、测试、生成物和 npm workspace 依赖。
- [ ] 删除 Secret Manager、服务账号、租约、双人审批、回放、监控和定时清理合同。
- [ ] 把 `firebase.json` 收敛为 Firestore Rules、Indexes、Auth/Firestore Emulator，不声明 Functions runtime。
- [ ] 重新生成 lockfile，确认不再安装 `firebase-admin`、`firebase-functions` 和 Google 服务端认证依赖。
- [ ] 运行 Spark 架构合同，确认旧后端入口已全部消失。

### Task 3: 定义 Spark Firestore 数据合同

**Files:**
- Replace: `contracts/data-contract.md`
- Replace: `contracts/usage-event-schema.json`
- Modify: `contracts/tool-registry.json`
- Modify: `contracts/tool-registry.schema.json`
- Modify: `scripts/validate-contracts.mjs`
- Replace: `docs/data-dictionary.md`
- Replace: `docs/data-retention.md`
- Modify: `tests/contracts/usage-event-schema.test.mjs`
- Modify: `tests/contracts/tool-registry.test.mjs`

- [ ] 定义 `pluginUsers`、32 分片 `usageDaily`、`errorLogs` 和 `portalMembers` 四个集合的字段、类型、大小上限和不可变字段。
- [ ] 定义每日分片事件字段，要求稳定 `event_id`、动作 key、发生时间、结果、持续时间和插件版本；`event_id` 必须稳定选择同一分片。
- [ ] 将错误调用栈上限固定为 8 KiB，并禁止 Token、凭据、请求正文和用户绝对目录进入错误字段。
- [ ] 保留 ImportTool 工具注册表及跨仓一致性检查，删除服务端 registry activation/generation 概念。
- [ ] 增加合同测试覆盖非法邮箱、跨 UID 数据、非法分片、过大事件数组、过长错误日志和未知工具 key。

### Task 4: 重写 Firestore Rules 与索引

**Files:**
- Replace: `firestore.rules`
- Replace: `firestore.indexes.json`
- Replace: `tests/rules/firestore.rules.test.mjs`

- [ ] 实现公司邮箱、已验证邮箱和 Firebase UID 校验。
- [ ] 允许普通插件用户只写自己的 `pluginUsers`、`usageDaily` 和 `errorLogs`，拒绝读取统计集合。
- [ ] 允许启用的查看者读取统计集合，拒绝成员管理写入。
- [ ] 允许管理员维护其他成员，并禁止当前管理员禁用或删除自己的记录。
- [ ] 禁止浏览器客户端改写事件归属、日期、工具 key 和错误日志归属。
- [ ] 为日期、UID、工具 key、结果和错误时间查询建立最少复合索引。
- [ ] 对 `usageDaily.events` 设置单字段索引豁免。
- [ ] 用 Firestore Emulator 验证未登录、非公司账号、普通用户、查看者和管理员完整权限矩阵。

### Task 5: 将网页数据层改为 Firestore 直连

**Files:**
- Modify: `web/src/portal/firebase.ts`
- Replace: `web/src/portal/api.ts`
- Create: `web/src/portal/store.ts`
- Create: `web/src/portal/analytics.ts`
- Modify: `web/src/vite-env.d.ts`
- Modify: `web/vite.config.ts`
- Delete: `web/src/plugin-pairing/api.ts`
- Delete: `web/src/plugin-pairing/session.ts`
- Delete: `web/src/plugin-pairing/PluginPairingPage.vue`
- Delete: `tests/e2e/stubs/api.ts`
- Modify: `web/src/App.vue`

- [ ] 删除全部 Functions URL、Bearer API 请求、配对路由和 Functions 错误映射。
- [ ] 通过 Firebase Web SDK 读取当前邮箱对应的 `portalMembers` 权限。
- [ ] 实现按日期、用户、工具和结果读取 `usageDaily` 非空分片，在浏览器内去重并生成汇总和趋势。
- [ ] 实现错误日志分页、成员查询和管理员成员变更。
- [ ] 对未授权账号在任何统计查询前停止，并清空已有受保护状态。
- [ ] 对查询取消、登出、权限降级和路由切换保留代际保护，防止旧响应回填。

### Task 6: 收敛统计网页功能与界面

**Files:**
- Replace: `web/src/portal/PortalApp.vue`
- Modify: `web/src/style.css`
- Modify: `tests/web/portal-page.contract.test.mjs`
- Replace: `tests/e2e/portal.spec.ts`
- Modify: `tests/e2e/stubs/firebase.ts`
- Modify: `tests/web/e2e-gate.contract.test.mjs`

- [ ] 保留登录、概览、用户统计、工具统计、事件明细、异常日志、成员管理和数据管理视图。
- [ ] 删除设备、租约、绑定、准入策略预览、主体 ID、代际和回放相关页面与文案。
- [ ] 概览显示总次数、活跃用户、活跃工具、成功率、失败数、每日趋势和 15,000 次安全额度占用。
- [ ] 事件明细显示每次操作的用户、工具、动作、准确时间、结果和持续时间。
- [ ] 普通无权限账号只显示无查看权限状态；查看者不显示成员管理和数据管理。
- [ ] 管理员可以按邮箱增加查看者、禁用/恢复/移除成员，并有明确确认步骤。
- [ ] 保持桌面和移动视口无文本溢出、无控件重叠，完成 Playwright 截图与交互验证。

### Task 7: 增加导出与手动清理

**Files:**
- Modify: `web/src/portal/store.ts`
- Modify: `web/src/portal/PortalApp.vue`
- Modify: `web/src/style.css`
- Modify: `tests/e2e/portal.spec.ts`

- [ ] 管理员可按日期范围导出事件和错误日志为 JSON/CSV。
- [ ] 删除操作必须先显示截止日期、预计文档数和不可恢复提示，再要求明确确认。
- [ ] 清理按受控批次执行，遵守每天 20,000 次删除限制；部分完成时显示剩余数量。
- [ ] 清理失败时保留可重试状态，不把未删除数据显示为已删除。
- [ ] 查看者不能调用导出管理和删除路径。

### Task 8: 简化环境、部署和运维文档

**Files:**
- Replace: `README.md`
- Replace: `docs/environment.md`
- Replace: `docs/deployment.md`
- Replace: `docs/permissions.md`
- Replace: `docs/portal-operations.md`
- Replace: `docs/rollback.md`
- Modify: `config/environments/.env.production.example`
- Modify: `config/environments/.env.test.example`
- Modify: `config/environments/.env.emulator.example`
- Modify: `.github/workflows/deploy-pages.yml`
- Modify: `.github/workflows/verify.yml`
- Modify: `scripts/validate-production-web-config.mjs`
- Modify: `tests/pages-deployment-gates.contract.test.mjs`
- Modify: `tests/e2e/pages-deployment.smoke.spec.ts`

- [ ] 文档明确项目只依赖个人 Firebase Spark、Google 登录、Firestore 和 GitHub Pages。
- [ ] 写明 Firebase Console 初始化、Google 授权域名、Firestore Rules/Indexes 发布和首位管理员文档创建步骤。
- [ ] 环境示例只保留公开 Firebase Web 配置和 Pages base path，不出现任何服务端秘密占位。
- [ ] GitHub Actions 只验证和发布静态 Pages，不申请 GCP workload identity 或部署 Functions。
- [ ] Pages 发布前检查只验证公开 Firebase Web 配置、GitHub Pages origin 和 Firebase Auth 授权域名；删除 Functions CORS smoke。
- [ ] 写明 Spark 日写入/读取/删除/存储额度、安全工作上限和手动清理流程。

### Task 9: 平台侧完整验证

**Files:**
- Modify as required by failures: `tests/`
- Modify as required by failures: `docs/`

- [ ] 运行结构、合同、工具注册表、Pages artifact 和 Web build 验证。
- [ ] 运行 Firestore Rules Emulator 权限矩阵。
- [ ] 运行 Playwright 桌面与移动端登录、角色、筛选、成员和清理流程。
- [ ] 搜索确认仓库没有 Functions、Secret Manager、Scheduler、租约和配对运行时残留。
- [ ] 用 Firebase Emulator 导入代表性每日分桶，确认逐次事件数量、首次/最后时间和错误统计一致。
- [ ] 记录仍需用户在 Firebase Console 与 GitHub 仓库手动完成的真实环境配置，不写入任何秘密或个人凭据。
