# 数据字典

| 集合 | 文档 ID | 关键字段 | 写入者 | 读取者 |
| --- | --- | --- | --- | --- |
| `pluginUsers` | Firebase UID | 邮箱、姓名、头像、最近登录、最近活跃、插件版本 | 同 UID 插件 | 启用的 admin/viewer |
| `usageDaily` | 日期 + UID + 工具 + `00..31` 分片 | 事件数组、首末时间、最后结果、插件版本 | 同 UID 插件 | 启用的 admin/viewer |
| `errorLogs` | 事件 ID | 脱敏摘要、调用位置、指纹、8 KiB 内调用栈 | 同 UID 插件 | 启用的 admin/viewer |
| `portalMembers` | 规范化门户邮箱（公司邮箱或 `snkhtm@gmail.com`） | `admin`/`viewer`、启用状态、变更元数据 | admin（不能锁定自己） | 本人读取自己的记录；admin 读取成员清单 |

事件结构由 `contracts/usage-event-schema.json` 定义，工具和动作结构由 `contracts/tool-registry.json` 定义。Firestore Rules 只做身份、归属、字段集合和大小边界校验，不替代客户端完整 JSON Schema 校验。

## 事件字段

`event_id` 用于幂等，`operation_id` 用于把开始和终态关联，`tool_key` 指向工具注册表中的工具，`action_key` 指向该工具的动作，`occurred_at` 保存准确 UTC 时间，`result` 表示开始、成功、失败、取消、中断或异常结果，`duration_ms` 只出现在终态，`plugin_version` 用于版本筛选。

错误事件通过 `error_log_id` 关联 `errorLogs`。网页从逐次事件计算每个用户、工具、动作的次数、首末时间和成功率。
