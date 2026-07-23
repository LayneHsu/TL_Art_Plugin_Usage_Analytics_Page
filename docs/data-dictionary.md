# 数据字典与统计口径

## 身份域

门户身份来自 Firebase Auth，主键是 Firebase UID，角色只有 `visitor` 和 `admin`。插件身份来自独立 Google OAuth/OIDC 配对，主键是经验证的 `issuer + subject` 派生的 `plugin_principal_id`。两者可以使用同一个公司邮箱，但不共享 UID、Token、角色或准入状态。

## 事件字段

客户端事件包含 `event_id`、`schema_version`、`registry_version`、`binding_id`、`tool_key`、`action_key`、`event_type`、客户端观测时间、插件/UE/UI 版本、进程实例、会话和 `operation_id`。服务端补充 `plugin_principal_id`、服务端接收时间和时间校正结果；客户端不能提交门户 UID、聚合增量或任意用户身份。

`run_started` 是唯一计数事件。`run_succeeded`、`run_failed`、`run_cancelled` 和 `run_interrupted` 通过 `operation_id` 关联同一次执行。入口点击、窗口打开和 `run_rejected` 用于诊断或导航分析，不计入工具使用次数。长期缺少终态的操作只显示为派生的 `abandoned`。

## 聚合维度

日汇总按公司时区和统一时间校正规则维护工具、动作、插件人员、结果、耗时和错误指纹维度。网页显示姓名、头像和邮箱只是当前资料快照；历史统计永远按不可变 `plugin_principal_id` 区分，同邮箱的新身份不会并入旧记录。

## 错误与保留

错误只保存有限的错误类别、脱敏摘要、稳定指纹、版本、关联键和首次/最近时间，不保存原始 traceback、路径、资产名、令牌或完整日志。原始事件、聚合、认证审计和错误摘要遵循各自保留策略；重放或清理不能删除仍在重建窗口内需要的数据。
