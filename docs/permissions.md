# 权限边界

## 两个用途

插件和统计网页使用同一个 Firebase Authentication 用户池，但入口、会话和授权用途完全分开：

- 插件用户只能写入自己的 `pluginUsers/{uid}`、`usageDaily` 和 `errorLogs`，不能读取统计。
- 网页只有 `portalMembers/{normalized_email}` 中 `enabled=true` 的 `viewer` 或 `admin` 才能读取统计集合。
- 网页管理员可以管理其他网页成员和清理统计文档，不能禁用、降级或删除自己的成员文档。
- 查看者只能读取，不能写成员、导出管理或删除数据。

插件不会读取 `portalMembers`，网页角色不会授予插件准入权限；两端不共享本机 Refresh Token、网页会话或角色缓存。当前个人 Spark 直连方案必须共用 Firebase Auth 用户池，才能让 Firestore Rules 验证插件客户端 UID。若要连身份提供方也分离，需要受信 custom-token/服务端写入能力，超出当前无后端方案范围。

首位管理员由项目所有者在 Firebase Console 手动创建 `portalMembers` 文档。网页不实现 bootstrap，也不使用自定义准入策略、设备绑定或租约。

## Firestore Rules

`firestore.rules` 是线上唯一权限边界。插件账号必须是已验证的 `@xindong.com`；统计网页门户账号允许公司邮箱以及明确配置的首位管理员 `snkhtm@gmail.com`。插件写入的 UID、邮箱、日期、工具 key、动作父级和错误日志归属由 Rules 检查。Rules 对每日分片只检查首事件和不可变既有事件集合，完整事件 schema、注册表动作归属和脱敏由共享合同与插件/网页写入边界负责。

`usageDaily` 和 `errorLogs` 的删除只允许 `activeAdmin()`，用于网页手动清理；`pluginUsers` 永不由网页删除。所有默认未声明集合均拒绝读写。

## GitHub Actions

- 验证工作流只有 `contents: read`，并运行合同、网页、Playwright 和 Rules Emulator 检查。
- Pages 工作流只有 `contents: read`、Pages 发布权限和 GitHub Pages OIDC；它只构建静态网页。
- 仓库不部署 Functions，不申请 Secret Manager、Cloud Scheduler、服务账号或 workload identity。

Firebase Web API key、项目 ID、Web app ID 和 OAuth Desktop Client ID 是公开客户端配置，不是秘密；Refresh Token、服务账号 JSON 和个人凭据不得进入仓库或网页包。
