# Spark 数据合同

本仓库定义 ImportTool 统计采集器和统计网页共用的 Firestore 数据形状。生产环境只有 Firebase Authentication、Cloud Firestore 和 GitHub Pages，没有 Functions、服务账号或可信写入服务。Firestore Rules 是在线权限边界，客户端必须同时遵守本合同和规则。

## 共同约束

- 公司报表日期使用 `Asia/Shanghai`，格式为 `YYYY-MM-DD`。
- 插件写入账号必须是已验证的 `@xindong.com` 邮箱；统计网页门户另外允许已验证的首位管理员 `snkhtm@gmail.com`，两者认证边界不互相放宽。
- 所有写入都带当前 Firebase UID；插件只能写自己的 UID，统计网页普通账号不能写统计数据。
- 工具和动作 key 必须存在于 `contracts/tool-registry.json`，不能用显示名称代替稳定 key。
- 事件 ID 在一次操作重试期间保持不变。上传失败重试不得修改事件内容。
- 每个 `usageDaily` 文档最多保存 500 个事件，每个事件 JSON UTF-8 硬上限为 1536 字节，整个分片 JSON 上限为 896 KiB；分片固定为 `00` 至 `31`。该组合按最大事件数给 Firestore 1 MiB 文档上限保留至少 128 KiB 编码余量。
- 失败事件引用同一个 `errorLogs` 文档。错误日志以事件 ID 为文档 ID，重复上传必须幂等。

## 集合

### `pluginUsers/{uid}`

插件登录后写入自己的资料快照。字段为 `uid`、`email`、`display_name`、`avatar_url`、`last_login_at`、`last_active_at`、`plugin_version` 和 `updated_at`。`uid` 必须等于文档 ID 和当前认证 UID；`email` 必须等于已验证的公司认证邮箱。姓名和头像仅用于网页展示，不复制到事件中。

插件用户可以创建或更新自己的资料，不能修改其他 UID、成员权限或统计数据。网页成员可以读取资料用于统计筛选，但不能通过普通插件账号读取全局资料。

### `usageDaily/{company_date}_{uid}_{tool_key}_{shard}`

每天、每个 UID、每个工具建立 32 个固定分片。使用事件 ID 的稳定哈希选择分片，文档 ID 的日期、UID、工具 key、两位分片号必须与字段 `company_date`、`uid`、`tool_key`、`shard` 一致。

字段为 `company_date`、`uid`、`tool_key`、`shard`、`events`、`first_occurred_at`、`last_occurred_at`、`last_result`、`plugin_version` 和 `updated_at`。`events` 是逐次事件数组，事件至少包含 `event_id`、`operation_id`、`tool_key`、`action_key`、`event_type`、`occurred_at`、`result` 和 `plugin_version`；事件内 `tool_key` 必须与分片文档 `tool_key` 相同，`action_key` 必须属于该工具。终态事件另有 `duration_ms`。失败事件可带 `error_log_id` 和脱敏 `error_summary`。

同一事件 ID 的重试必须落在同一分片。客户端在提交前去重，网页读取时再次按事件 ID 去重；网页不能把 `run_started` 以外的事件重复计为工具使用次数。Rules 限制数组长度、文档归属和不可变维度，并用 `hasAll` 防止已有事件被替换或删除；新建分片只做首事件的最小形状校验，更新允许任意批量追加。Rules 不遍历事件数组或中央注册表来判断每个新事件的字段和 key 归属；完整事件字段、`event.tool_key` 与文档工具的一致性、`action_key` 前缀和注册表存在性由共享 JSON Schema、注册表合同及插件校验拒绝。

### `errorLogs/{event_id}`

错误日志保存 `uid`、`company_date`、`tool_key`、`action_key`、`occurred_at`、`error_type`、`summary`、`call_site`、`fingerprint`、`stack` 和 `plugin_version`。文档 ID 必须等于事件 ID。`stack` 按 UTF-8 字节限制为 8 KiB，可以保留 `Traceback` 等已脱敏结构标识，但不得包含 token、密码、凭据、请求/响应正文、邮箱、JWT、UNC 路径或用户绝对目录。完整错误只供授权统计网页读取，普通插件用户不能查询。

### `portalMembers/{normalized_email}`

统计网页成员以规范化门户邮箱为文档 ID，字段为 `email`、`role`、`enabled`、`created_at`、`created_by`、`updated_at` 和 `updated_by`。门户邮箱只能是 `@xindong.com` 或明确配置的首位管理员 `snkhtm@gmail.com`；`role` 只能是 `admin` 或 `viewer`。首位管理员由 Firebase Console 手动建立，网页不实现 bootstrap。

启用的管理员和查看者可以读取四个集合。管理员可维护其他成员；查看者不能写成员。管理员不能通过网页禁用、删除或降级自己的成员文档。

## 身份边界

插件账号和统计网页共用 Firebase Authentication 用户池，但入口、会话和授权用途分离。插件账号只能写自己的 `pluginUsers`、`usageDaily` 和 `errorLogs`，不能读取统计；只有启用的 `portalMembers` 才能读取统计。不得使用 portal UID、插件 token、Functions 身份或客户端可修改的角色字段代替 Firebase Auth 身份。当前 Spark 无后端方案不能把身份提供方拆成两个 Firebase 项目；若未来必须做到身份源分离，应先引入受信 custom-token/写入服务再迁移合同。

## 额度和重试

Spark 的 Firestore 免费写入额度按每天 20,000 次估算；一次完整工具操作至少包含 `run_started` 和一个终态，通常需要两次 `usageDaily` 写入，失败操作还可能额外写一次 `errorLogs`。因此网页显示每天 5,000 次工具操作的安全工作线，预留账号资料、成员变更、错误日志和重试的空间；它是提醒线，不是服务端硬限制。网页默认查询最近 30 天并按日期、用户和工具限制结果。网络失败只保留本地 JSONL 队列并重试，不改变事件 ID 或统计次数。
