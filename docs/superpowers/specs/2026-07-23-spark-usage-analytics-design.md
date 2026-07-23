# TL Art Tool Usage Analytics Spark 轻量化设计

## 1. 设计结论

统计系统改为个人 Firebase Spark 可承载的轻量架构。系统只服务 ImportTool 内部使用统计，不再按企业级审计平台建设。

保留 Firebase Authentication、Cloud Firestore 和 GitHub Pages。删除 Firebase Functions v2、Secret Manager、Cloud Scheduler、自定义设备配对、设备凭据、一小时租约签名、双人审批、回放重建、自动保留策略和复杂监控。

`TL_Art_Tool_Usage_Analytics` 继续是独立 Git 仓库，只负责 Firestore 合同、权限规则、统计网页、部署和运维文档。ImportTool 中的 `usage_analytics` 继续是插件内部模块，只负责登录、采集、本地队列和上传。两个项目不嵌套仓库，也不共享运行时代码。

## 2. 目标

- 记录哪个公司账号在什么时间使用了哪个工具和动作。
- 每次工具操作都保留独立事件信息，包括成功、失败、取消和中断结果。
- 用户操作发生 Python 异常时记录脱敏后的错误摘要和调用栈。
- 插件主窗口显示当前登录用户的姓名、邮箱和头像。
- 统计网页只允许预先授权的管理员和查看者访问。
- 管理员可在网页中增加、禁用和移除查看者。
- 统计功能默认开启；开发者可通过随插件发布的配置文件关闭。
- 统计关闭后不加载认证、网络、队列和上传模块，也不阻止任何工具使用。
- 统计开启后要求公司 Google 账号登录；Firebase 登录令牌自动刷新，不再实现自定义租约。
- 网络或 Firestore 临时失败时事件保存在本机队列并自动重试。
- 全部生产能力在个人 Firebase Spark 和 GitHub Pages 范围内运行。

## 3. 非目标

- 不防御用户主动修改插件或伪造自己的统计数据。
- 不建设设备绑定、远程设备撤销或独立插件身份中心。
- 不建设 Secret Manager、服务账号调用、Cloud Functions 或 Cloud Scheduler。
- 不建设双人审批、审计级不可抵赖、回放重建、代际切换和自动告警。
- 不向普通插件用户提供统计网页入口或个人统计页面。
- 不自动删除历史数据；清理由管理员网页显式触发。

## 4. 总体架构

ImportTool 使用 Google OAuth Desktop + PKCE 在本机浏览器完成公司账号登录，再通过 Firebase Authentication REST API 获取 Firebase ID Token 和 Refresh Token。Refresh Token 保存在 Windows Credential Manager，ID Token 只保存在进程内并按 Firebase 规则刷新。

插件通过 Cloud Firestore REST API 直接写入当前用户自己的资料、每日使用分桶和错误日志。插件不依赖 Firebase Python SDK，不引入 UE4.26 环境无法稳定提供的第三方运行库。

统计网页由 GitHub Pages 托管，使用 Firebase Web SDK 登录和访问 Firestore。网页与插件共用同一个 Firebase Authentication 用户池，但权限用途分离：普通公司用户只能由插件写自己的数据；只有 `portalMembers` 中启用的管理员或查看者才能读取统计集合。

Firestore Rules 是唯一线上权限边界。所有 Firebase Web 配置、Firebase API Key 和 OAuth Client ID 都按公开客户端标识处理，不引入服务端秘密。

## 5. 身份与权限

### 5.1 插件用户

- 必须使用已验证的公司 Google 邮箱登录。
- 只能创建或更新 `uid` 等于 `request.auth.uid` 的个人资料和使用分桶。
- 只能创建 `uid` 等于自身 UID 的错误日志。
- 不能读取全局使用数据、错误日志或门户成员。
- 不能授予自己统计网页访问权限。

### 5.2 统计网页查看者

- 必须通过 Firebase Google 登录。
- 登录邮箱必须存在于 `portalMembers` 且状态为启用。
- 可以读取用户、工具、事件和错误统计。
- 不能增加、修改或移除门户成员。

### 5.3 统计网页管理员

- 具有查看者的全部权限。
- 可以增加、禁用、恢复和移除查看者。
- 可以发起数据导出和按截止日期清理旧分桶、旧错误日志。
- 不能通过网页移除或禁用自己的管理员记录，避免误锁死当前入口。

首位管理员由项目所有者在 Firebase Console 中手动创建一条 `portalMembers` 文档。后续成员由网页管理，不需要 Functions bootstrap。

## 6. 数据模型

### 6.1 `pluginUsers`

每个 Firebase UID 一条资料，包含邮箱、显示名、头像 URL、最后登录时间、最后活跃时间和最近插件版本。事件只保存 UID，不重复保存姓名和头像。

### 6.2 `usageDaily`

每个“公司日期 + UID + 工具 key”使用 32 个固定每日分片。`event_id` 通过稳定哈希选择 `0..31` 的分片，文档保存 UID、工具 key、日期、分片编号、插件版本和 `events` 数组。文档 ID 必须由日期、UID、工具 key 和两位分片编号稳定组成。

每个事件至少包含稳定 `event_id`、动作 key、实际发生时间、结果、持续时间和插件版本。失败事件附带错误日志 ID 和短错误摘要。相同 `event_id` 的重试必须选择同一分片并保持完整事件负载不变，通过数组去重追加避免重复事件。

网页从事件数组计算次数、首次时间、最后时间、成功率和失败率。`events` 字段不建立 Firestore 单字段索引，避免数组索引占用存储和索引条目。

### 6.3 `errorLogs`

每个失败事件最多一条错误文档。文档包含事件 ID、UID、工具 key、动作 key、发生时间、错误类型、脱敏摘要、调用位置、插件版本和截断后的调用栈。调用栈 UTF-8 内容上限为 8 KiB，不采集资产内容、Token、Refresh Token、绝对用户目录或请求响应正文。

### 6.4 `portalMembers`

以规范化公司邮箱作为文档 ID，保存 `admin` 或 `viewer` 角色、启用状态、创建时间、创建者和更新时间。普通插件用户不能读取该集合。

## 7. 配额与容量

设计基于 Spark 免费额度：每天 20,000 次写入、50,000 次读取、20,000 次删除、1 GiB 存储和每月 10 GiB 出站流量。

每次成功操作最坏按一次 Firestore 写入计算；失败操作可能额外写一条错误日志。系统安全工作上限设为每天 15,000 次工具操作，网页显示当日事件数和额度占用提示。

插件可以把本机队列中属于同一每日分片的多个事件合并到一次 Firestore 提交，但容量评估不依赖批量优化。32 个稳定分片避免单个高频用户和工具的事件数组逼近 Firestore 1 MiB 单文档上限。网页默认读取最近 30 天的非空每日分片，详细事件按日期、用户和工具筛选，避免无条件扫描全部历史数据。

Spark 不使用 TTL 自动删除。管理员通过网页先导出，再按截止日期分批删除旧 `usageDaily` 和 `errorLogs`；每批删除数量受控，并显示预计删除文档数。

## 8. 插件运行行为

统计配置的 `enabled` 默认值为 `true`。配置缺失或非法时继续按启用处理并记录错误，避免通过删除配置静默绕过公司登录。只有开发者显式把 `enabled` 设为 `false` 才进入紧急旁路。

统计关闭时，主窗口不显示账号操作，不导入 Firebase 认证和上传实现，不读取 Windows Credential Manager，不创建本机队列，不连接网络，全部工具直接可用。

统计开启时，主窗口创建账号桥接。已有 Refresh Token 时后台刷新账号；没有有效登录时显示登录入口并阻止工具动作。Firebase ID Token 失效且无法刷新时，工具保持阻止状态，直到重新登录或开发者关闭统计开关。

用户成功登录后，主窗口左侧账号区域显示头像、显示名和邮箱。普通界面不展示 Token、项目 ID、队列路径、重试次数等技术信息。上传状态和本机队列诊断只在现有 Debug 日志总开关开启时显示。

事件先写入本机 JSONL 队列，再由后台上传器发送。网络失败、令牌刷新失败和 Firestore 临时错误只影响上传器，不丢弃队列。退出 UE 或热更新时保留未确认事件，下次登录同一 UID 后继续上传；不同 UID 的队列不能互相上传。分片算法是跨项目合同，插件和网页测试必须使用同一分片数量与文档 ID 规则。

## 9. 统计网页

网页包含登录、概览、用户统计、工具统计、事件明细、异常日志、成员管理和数据管理。

普通插件用户登录网页时只显示“没有查看权限”，不发起受保护集合查询。查看者可使用日期、用户、工具、动作和结果筛选。管理员额外看到成员管理和数据管理。

概览显示总使用次数、活跃用户、活跃工具、成功率、失败次数、每日趋势和当日 Spark 写入安全额度占用。事件明细保留每一次工具操作的准确时间。

## 10. 部署与运维

- Analytics 使用独立 Firebase 项目，不复用 PCG Firebase 项目。
- Firebase 项目保持 Spark 方案。
- 启用 Google 登录和 Cloud Firestore。
- 为 GitHub Pages 配置授权域名和公开 Firebase Web 参数。
- 为 ImportTool 配置 Google OAuth Desktop Client ID、Firebase API Key、Project ID 和公司邮箱域名。
- Firestore Rules 和 Indexes 通过 Firebase Console 或本地 Firebase CLI 部署，不部署 Functions。
- GitHub Actions 只负责验证和 GitHub Pages 静态部署。
- 仓库和插件包中不得出现 Firebase 服务账号 JSON、Refresh Token 或任何用户凭据。

## 11. 验收标准

- 仓库中不存在 `functions/`、Functions 部署步骤、Secret Manager 参数和 Scheduler 定义。
- 普通公司用户可以登录插件、使用工具并产生逐次记录，但无法读取统计数据。
- 未登录用户在统计启用时无法执行工具；统计关闭后无需登录即可执行。
- 管理员和查看者登录网页后只获得其角色允许的功能。
- 每次工具操作在 `usageDaily.events` 中保留准确时间和结果。
- 错误日志调用栈不超过 8 KiB且通过脱敏测试。
- 上传失败后重启 UE，队列仍可由同一 UID 继续上传且不重复计数。
- 网页构建、Firestore Rules Emulator、ImportTool Python 合同测试和 UE Editor 登录/上传探针全部通过。
