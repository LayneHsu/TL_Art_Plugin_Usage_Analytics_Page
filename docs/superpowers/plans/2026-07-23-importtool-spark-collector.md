# ImportTool Spark Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. This plan intentionally contains no example implementation code, following the project owner's documentation preference.

**Goal:** 将 ImportTool 已有统计模块从 Functions 配对/设备凭据/租约上传改为 Firebase 公司账号登录、Firestore 直写和逐次事件记录，同时保留紧急关闭开关与现有工具采集覆盖。

**Architecture:** `usage_analytics_runtime.py` 继续提供轻量开关和热更新边界；启用后由模块完成 Google OAuth Desktop + PKCE、Firebase Token 刷新、Windows Credential Manager 持久化、本机 JSONL 队列和 Firestore REST 批量上传。现有 `UIFunctions`、V6 适配器、操作句柄和异常钩子继续作为采集入口。

**Tech Stack:** UE4.26 Python、PySide2、Python 标准库 HTTP/JSON/PKCE、Windows Credential Manager、Firebase Authentication REST API、Cloud Firestore REST API。

---

### Task 1: 固化轻量化回归边界

**Files:**
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_backend_contract.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_runtime_switch.py`
- Replace: `PythonFile/v8_framework/tests/test_usage_analytics_auth_core.py`
- Delete: `PythonFile/v8_framework/tests/test_usage_analytics_pairing_flow.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_account_ui_source.py`

- [ ] 增加源码门禁，禁止统计模块出现 Functions endpoint、Secret Manager、设备 binding、pairing、lease token 和自定义签名租约。
- [ ] 保留并强化 `enabled=false` 时不导入认证/网络/队列模块、不读取凭据且工具直接放行的测试。
- [ ] 增加 `enabled=true` 且未登录时阻止工具动作、登录有效时放行的测试。
- [ ] 保留工具入口、同步动作、异步操作、V6、异常捕获和热更新覆盖基线。
- [ ] 先运行新门禁并确认当前旧实现失败，再开始替换实现。

### Task 2: 将运行配置改为公开 Firebase 客户端配置

**Files:**
- Replace: `PythonFile/v8_framework/core/usage_analytics/usage_analytics_config.json`
- Replace: `PythonFile/v8_framework/core/usage_analytics/config.py`
- Modify: `PythonFile/usage_analytics_runtime.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_service_client.py`

- [ ] 配置只保留 `enabled`、Firebase API Key、Project ID、Google OAuth Desktop Client ID、公司邮箱域名、Firestore REST 基址、连接/读取超时和统计网页 URL。
- [ ] 删除 Functions base URL、endpoint paths、配对页面和服务端 allowlist。
- [ ] 保持配置从当前插件目录动态解析，不写死开发者机器路径。
- [ ] 将运行状态从 `lease_active` 改为 `auth_active`，删除租约语义。
- [ ] 配置缺失或非法时进入可见的登录门禁失败；显式 `enabled=false` 仍作为无认证旁路。

### Task 3: 实现 Google/Firebase 插件登录

**Files:**
- Create: `PythonFile/v8_framework/core/usage_analytics/firebase_auth.py`
- Replace: `PythonFile/v8_framework/core/usage_analytics/credentials.py`
- Replace: `PythonFile/v8_framework/core/usage_analytics/service.py`
- Replace: `PythonFile/v8_framework/core/usage_analytics/account_controller.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/account.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/factory.py`
- Delete: `PythonFile/v8_framework/core/usage_analytics/pairing.py`
- Delete: `PythonFile/v8_framework/core/usage_analytics/lease.py`
- Modify tests: `PythonFile/v8_framework/tests/test_usage_analytics_auth_core.py`
- Modify tests: `PythonFile/v8_framework/tests/test_usage_analytics_account_controller.py`

- [ ] 使用本机浏览器、随机 loopback 端口、OAuth state、nonce 和 PKCE S256 完成 Google Desktop 登录。
- [ ] 用 Google ID Token 调用 Firebase Authentication REST API，校验 Firebase UID、已验证邮箱和公司邮箱域名。
- [ ] 只把 Firebase Refresh Token 和最小账号资料写入 Windows Credential Manager；ID Token、OAuth code 和 PKCE verifier 不落盘。
- [ ] 在进程内跟踪 ID Token 到期时间，并在到期前后台刷新。
- [ ] 登录取消、回调超时、邮箱域名错误、Token 刷新失败和主动退出都返回稳定账号状态，不把原始 Token 写入日志。
- [ ] 主动退出删除本机 Refresh Token，停止上传并保持当前 UID 队列不被其他账号接管。

### Task 4: 实现 Firestore REST 写入客户端

**Files:**
- Create: `PythonFile/v8_framework/core/usage_analytics/firestore_client.py`
- Replace: `PythonFile/v8_framework/core/usage_analytics/client.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_service_client.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_uploader.py`

- [ ] 实现 Firestore REST Value 编解码、认证请求、错误分类和有限响应大小。
- [ ] 更新 `pluginUsers/{uid}` 的公司邮箱、姓名、头像、最后登录、最后活跃和插件版本。
- [ ] 将同一 UID、公司日期和工具 key 的事件追加到 `usageDaily` 每日分桶。
- [ ] 对同一 `event_id` 的重试保持幂等，避免网络响应丢失导致重复记录。
- [ ] 失败事件按相同 `event_id` 写入最多一条 `errorLogs` 文档，调用栈限制为 8 KiB。
- [ ] 将未登录、权限拒绝、配额耗尽、请求过大和临时网络错误区分为阻止、隔离或重试结果。

### Task 5: 将本机队列从 binding 隔离改为 UID 隔离

**Files:**
- Modify: `PythonFile/v8_framework/core/usage_analytics/event_queue.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/events.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/uploader.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/collector.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/diagnostics.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_queue.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_events.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_multi_instance.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_hot_reload.py`

- [ ] 事件身份字段改为 Firebase UID，不保存 binding、principal 或 lease 字段。
- [ ] 队列目录按 Firebase UID 隔离，账号切换不能重标或上传其他 UID 的事件。
- [ ] 上传器从账号服务获取当前有效 ID Token，不再请求或等待租约。
- [ ] 同一批次按每日分桶合并 Firestore 写入，同时保留每个事件的准确发生时间和结果。
- [ ] 保留原子领取、崩溃恢复、损坏行隔离、容量限制、退避重试和多 UE 实例安全。
- [ ] 热更新和 UE 退出只停止线程，不删除 Refresh Token 或未确认队列。

### Task 6: 保留并收敛逐次采集与错误上报

**Files:**
- Modify: `PythonFile/v8_framework/core/usage_analytics/events.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/dialog_actions.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/exception_hooks.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/v6_adapter.py`
- Modify: `PythonFile/v8_framework/ui/ui_functions.py`
- Modify: `PythonFile/importAsset.py`
- Modify tests: `PythonFile/v8_framework/tests/test_usage_analytics_operation_coverage.py`
- Modify tests: `PythonFile/v8_framework/tests/test_usage_analytics_sync_action_semantics.py`
- Modify tests: `PythonFile/v8_framework/tests/test_usage_analytics_v6_coverage.py`
- Modify tests: `PythonFile/v8_framework/tests/test_usage_analytics_error_redaction.py`

- [ ] 保留工具打开、动作开始、成功、失败、取消、中断和意外异常的现有覆盖。
- [ ] 每个终态事件保存准确 UTC 时间、公司日期、工具 key、动作 key、持续时间、结果和插件版本。
- [ ] 失败事件保存稳定错误 ID、错误类型、脱敏摘要、调用位置和截断调用栈。
- [ ] 不采集资产名称列表、文件内容、用户输入正文、Firebase Token、OAuth 回调参数和本机绝对用户目录。
- [ ] 确保统计采集异常只写 `unreal.log_error()` 并进入本机诊断，不覆盖原工具异常或改变原业务返回值。

### Task 7: 简化主窗口账号 UI

**Files:**
- Replace: `PythonFile/v8_framework/ui/usage_analytics_account.py`
- Modify: `PythonFile/v8_framework/ui/main_window.py`
- Modify: `PythonFile/v8_framework/ui/pages/settings_page.py`
- Modify: `PythonFile/v8_framework/ui/ui_config.py`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_account_ui_source.py`
- Modify: `PythonFile/v8_framework/tests/test_settings_page_source.py`

- [ ] 主窗口左下角只显示头像、显示名/邮箱和登录状态。
- [ ] 未登录时提供“登录公司账号”，已登录时提供“重新验证”和“退出登录”。
- [ ] 删除绑定、配对、租约剩余时间、设备状态和配对网页文案。
- [ ] 普通模式隐藏项目 ID、队列路径、重试次数、待上传数量和最后请求错误等技术信息。
- [ ] 只有现有 Debug 日志总开关开启时，设置页才显示非敏感上传诊断。
- [ ] 登录网络工作在后台执行，Qt 控件和浏览器结果只通过主线程信号更新。
- [ ] 统计关闭时不显示账号操作区，所有工具入口直接可用。

### Task 8: 清理旧命名、测试和发布边界

**Files:**
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_backend_contract.py`
- Modify: `PythonFile/v8_framework/core/usage_analytics/__init__.py`
- Modify: `PythonFile/module_loader.py`
- Modify: `FilterPlugin.ini`
- Modify: `PythonFile/v8_framework/tests/test_usage_analytics_runtime_switch.py`

- [ ] 全量搜索并删除生产代码中的 pairing、binding、principal、lease、Functions endpoint 和 `usage-analytics.xdverse.cn` 旧服务依赖。
- [ ] 保留统计模块按开关惰性加载、热更新和模块缓存清理规则。
- [ ] 发布包含运行时、公开配置和采集模块，排除测试、Debug、本机队列和任何凭据文件。
- [ ] 保持 Analytics Git 仓库名称和绝对路径不进入插件运行时代码或配置。
- [ ] 更新模块 API 版本和测试期望，防止旧模块被 UE 热更新缓存误用。

### Task 9: ImportTool 静态与运行时验证

**Files:**
- Create: `PythonFile/dev_runner/usage_analytics_spark_runtime_probe.py`
- Modify as required by failures: `PythonFile/v8_framework/tests/test_usage_analytics_*.py`

- [ ] 运行全部 `test_usage_analytics_*.py`、launcher/settings 源码合同和工具入口覆盖测试。
- [ ] 验证统计关闭时不导入认证模块、不连接网络、不开线程且 V6/V8 工具可直接运行。
- [ ] 在 UE Editor 中验证公司 Google 登录、头像/姓名显示、Token 刷新、工具门禁和退出登录。
- [ ] 在 UE Editor 中执行成功、失败、取消和异常工具动作，核对本机队列与 Firestore 每日分桶。
- [ ] 模拟断网、恢复网络和 UE 重启，确认队列由同一 UID 继续上传且没有重复事件。
- [ ] 运行 Web Remote Control 探针并要求 `ReturnValue: true`；静态测试通过不能替代 UE Editor 实跑。

### Task 10: 双项目集成验收

**Files:**
- Modify if contract drift is found: `F:/XD_Work/AI_WorkSpace/TL_Art_Tool_Usage_Analytics/contracts/`
- Modify if contract drift is found: `PythonFile/v8_framework/core/usage_analytics/`
- Modify if contract drift is found: both projects' tests and docs

- [ ] 使用 Analytics Firestore Emulator 对 ImportTool 客户端生成的代表性写入做合同校验。
- [ ] 核对工具注册表、事件结果枚举、公司日期和错误字段在两个项目中完全一致。
- [ ] 用普通插件账号确认只能写自己的数据且不能读取统计。
- [ ] 用 viewer 确认能看统计但不能管理成员，用 admin 确认能管理成员和数据。
- [ ] 统计当天操作数和安全上限占用，确认网页计数与 Firestore 分桶事件数一致。
- [ ] 最终搜索两个项目，确认不再依赖 Functions v2、Secret Manager、Cloud Scheduler、自定义租约和旧配对接口。
