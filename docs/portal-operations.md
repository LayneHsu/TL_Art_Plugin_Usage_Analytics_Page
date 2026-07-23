# 统计门户操作边界

统计门户使用 Firebase Auth 的 Google 会话。门户身份只包含 Firebase UID、公司邮箱和展示资料；Functions 每次读取 `portalUsers/{uid}` 的当前状态和角色后才执行查询。浏览器不直接读取用户级统计、插件人员、设备或审计集合。

门户准入使用 `portalAccessPolicies`：精确邮箱规则优先于域名规则，域名规则只能授予访客。策略文档 ID 和 `value_hash` 使用 `PORTAL_POLICY_HMAC_KEYS_JSON` 中 current key 的 HMAC-SHA256，不使用可枚举的无密钥邮箱哈希。轮换时通过 `previousKeyIds` 按 newest-to-oldest 显式排列短期 previous keys；读取严格按 current-first 和该顺序查找，较新的 disabled 记录会阻断更旧的 enabled 记录。登录命中最新旧 key 时在同一 Firestore 事务中迁移到 current ID。确认全部有效策略和 disabled tombstone 已迁移后才能移除旧 key。未登记公司账号、未验证邮箱、禁用和移除状态都拒绝进入。

首位管理员由 `PORTAL_BOOTSTRAP_ADMIN_JSON` 配置唯一 bootstrap ID 和精确公司邮箱。只有该邮箱完成已验证 Google 登录、`portalBootstrapState/{bootstrapId}` 尚未消费且系统没有有效管理员时，Functions 才在一个事务内创建或提升首位管理员、消费 marker 并写入 `portal_first_admin_bootstrap` 审计。并发请求只能有一个成功；已有管理员、已消费 marker、禁用/移除的目标身份和重放都不能自助提权。审计写入失败会回滚用户和 marker。配置即使继续存在，已消费 marker 也不会重新打开 bootstrap；网页和浏览器 Firestore 客户端都不能创建管理员。

访客只看团队级汇总和脱敏错误趋势。团队分组和错误分组的独立人数低于最小群体阈值时，Functions 不返回该行；访客不能通过 URL、筛选参数或 Firestore 客户端读取人员明细或 `errorAggregates`。管理员才可查看按不可变 `plugin_principal_id` 聚合的用户统计；邮箱、姓名和头像只作为当前资料显示，同邮箱的历史插件主体不合并。

管理员可从错误摘要查询关联事件。`portalErrorDetails` 必须同时绑定公司日期范围、fingerprint、摘要行的工具和动作，并可选绑定当前插件版本筛选；Firestore 查询在读取阶段应用全部条件，不能先按 fingerprint 扫描后在内存过滤。接口只返回事件 ID、插件人员 ID、当前姓名和邮箱、设备绑定 ID、工具/动作/事件类型、插件版本、发生时间和接收时间，并按校正发生时间与事件 ID 稳定分页。接口不返回原始日志、traceback、call site 或完整错误对象；允许、拒绝和失败的查询都会写入包含有界版本字段的审计元数据。

四个报表 HTTP 接口都在进入 PortalService 或 Firestore 前执行同一套输入校验：`from` 和 `to` 必须是有效的 `YYYY-MM-DD` 公司日期，首尾包含的范围最多 366 天且 `from` 不能晚于 `to`；工具、动作和插件人员键使用 1 到 128 个字符的安全键；`result` 只能是 `succeeded`、`failed`、`cancelled` 或 `interrupted`；错误指纹必须是 64 位小写十六进制，插件版本必须是长度不超过 64 的 SemVer；`limit` 只能是 1 到 100 的整数；分页 `cursor` 必须是长度不超过 1024 的规范 base64url 值。错误明细还必须同时提供 fingerprint、tool_key 和 action_key。缺失或非法客户端输入统一返回 `invalid_request` 和 HTTP 400，不调用查询，也不把内部异常细节返回给浏览器。

人员页面的角色变更、禁用、恢复、移除和准入规则修改都需要明确目标确认。管理 HTTP 边界不静默补默认值：人员角色只允许 `visitor` 或 `admin`，状态只允许 `active`、`disabled` 或 `removed`；准入规则 kind 只允许 `email` 或 `domain`，role 只允许 `visitor` 或 `admin`，域名规则只能是 `visitor`，`enabled` 必须是明确的布尔值。缺失或非法 schema 在读取管理员状态、写审计或执行变更前统一返回 `invalid_request` 和 HTTP 400。schema 合法但确认值与目标不一致时，服务层仍按确认保护规则拒绝并审计。人员变更、准入规则变更、bootstrap 和管理员用户级查询写入对应认证或查询审计。管理员不能修改自己的角色或状态；Functions 重新检查当前角色和有效管理员数量，最后一名有效管理员不能被降级、禁用或移除。门户禁用不会撤销插件人员、设备或租约，插件认证仍由独立的 `plugin-*` Functions 处理。

人员、准入规则和设备列表的 `limit` 必须是 1 到 100 的有限整数；客户端 cursor 必须是长度不超过 1024 的规范 base64url。HTTP 边界把内部 Firebase UID、策略文档 ID 或设备绑定 ID 封装为带版本和端点类型的不透明值，下一页请求校验端点类型并解码后才传给服务层，禁止把客户端 cursor 原样透传给 Firestore；缺失、未知、跨端点或非规范 cursor 统一返回 `invalid_request` 和 HTTP 400，且不执行查询或写入审计。人员列表按 Firebase UID 使用 Firestore cursor 分页，每次只读取 `limit + 1` 条。邮箱和显示名在服务端写入 `portalUsers` 时生成有界、规范化的前缀索引；搜索使用 `array-contains` 查询该索引，不扫描全体用户。搜索语义是规范化前缀匹配，不是任意子串匹配；内部 `search_terms` 字段不会通过人员接口返回。已有数据若来自索引功能上线前，必须在启用人员搜索前由受控迁移重新写入索引，禁止在请求路径用全表扫描兜底。

网页实时监听当前用户自己的 `portalUsers/{uid}`。用户被禁用或移除时会立即中止在途查询、清空会话和受保护数据，并进入独立的无权限页面；管理员降级为访客时会先清空管理员数据，再按访客权限重新加载，不复用旧结果。

登出、会话失效、禁用、移除或权限降级时，网页会清空日期、工具、动作、结果、版本、插件人员等筛选条件，人员搜索、准入编辑值、身份预览输入和结果、所有分页 cursor、错误详情选择与受保护数据。身份预览和报表请求各自使用取消信号与请求代际，旧响应不能在撤权后写回页面。时间筛选使用 `Asia/Shanghai`，展示字段同时保留实际发生时间、服务端接收时间和校正状态。门户的 Firebase Token 不能调用插件配对、租约或事件接收入口。
