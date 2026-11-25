# DSH 管理验收

本页记录 `feature/dsh-management` 对交接要求 A01–A16 的当前验收状态。自动化只使用合成数据和临时 `DSH_HOME`。用户配置的 Z.AI route 已经只读核对；本次修复只重载本地 Paseo 插件，没有写入 DSH profile 或 credential。`Blocked` 表示实现或自动化证据已具备，但通过条件要求真实 Provider、真实 UI、生产重启、远程设备或经授权的破坏性生命周期操作，当前没有相应授权或设备。

## 环境与契约

- 基线提交：`b3c58d571b611950c28e29a9e360a99938c0f3e4`。
- 开发分支：`feature/dsh-management`。
- 已安装 DSH Desktop/bundled CLI：`0.2.3-alpha.2`。Windows bundled CLI 在临时 DSH home 上完成 bridge initialize、模型目录和 session list smoke，不依赖 WSL 或 PATH 修改。
- 安装版 `paseo` profile 提供 `settings`、`credentials-local`、`llm-pi-ai` 和 `plugin-manager` 原生服务。管理实现只调用这些服务，不复制 `desktop` profile，也不使用 private Desktop RPC。
- 安装目录中 OpenCode Go route 的目标模型是 `deepseek-v4.1-flash`，协议是 `openai-completions`，endpoint catalogue 是 `https://opencode.ai/inference/go/v1`。公开说明见 [OpenCode Go](https://opencode.ai/docs/console/go/)。
- 安装目录中 Z.AI route 的目标模型是 `glm-5.3`，协议是 `openai-completions`，endpoint 是 `https://api.z.ai/api/coding/paas/v4`。模型能力以 DSH 实际目录为准；公开说明见 [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)。这些值来自审计，不硬编码进插件。
- `desktop` profile 的已安装自定义 bundle 包括 dynamic-subagents、session-task-notifier、ModLens 和 OpenFlowFrames。dynamic-subagents 的 runtime contract 与 `paseo` profile 相容，但其 DSH browser settings UI 不由 Paseo 渲染；session-task-notifier 依赖 DSH client UI，不能在 Paseo 中宣称完整兼容。没有把这些 bundle 自动复制到 `paseo`。

## A01–A16

| ID | 状态 | 证据与剩余工作 |
|---|---|---|
| A01 | Pass | 仓库 build/typecheck 通过；bundled Windows CLI `0.2.3-alpha.2` 使用临时 DSH home 完成真实 bridge smoke。跨平台测试夹具覆盖带空格的 Windows 路径及 `.cmd` 解析。 |
| A02 | Blocked | 自动化覆盖 provider 新增/编辑/删除、DSH revision 冲突、write read-back、保留未知字段和无关 route。尚未获准通过真实 Paseo UI 写入 disposable/production profile。 |
| A03 | Blocked | 客户端只发送一次新值；服务端只调用 `credentials.set/unset/describe`，不调用 secret resolve；响应和错误不回显 secret；配置成功而 credential 失败会报告部分成功。真实轮换后下一请求使用新 key 尚未授权验证。 |
| A04 | Blocked | 非 inference catalogue check 标注 `billable: false`，并清理错误正文；已安装 provider 可直接返回本地 catalogue，因此该检查不验证 endpoint、凭证或 Coding Plan 权限。有效/无效真实连接测试仍需授权并披露可能计费的 inference。 |
| A05 | Blocked | 手工模型 CRUD、catalogue discovery、metadata 及 subagent 显式 allowlist 保留已有 contract 测试；写后目录刷新核对目标模型是否进入 picker。本地插件重载后，Paseo CLI 已实际列出用户配置的 `zai/glm-5.3`。尚未通过真实 Paseo UI 完成整个生命周期。installed DSH schema 没有独立 model enable flag，因此界面不伪造该能力。 |
| A06 | Blocked | 已核对两个目标 route 的 installed catalogue 和官方文档；未取得真实 API key，也未获准产生可能计费的 inference 请求。 |
| A07 | Blocked | 既有 Provider 保留 native agent/session ID、history、cwd 和 session resume；模型 configure 与恢复路径有回归测试。DeepSeek → GLM → DeepSeek 的真实同一 session 执行仍依赖 A06。 |
| A08 | Blocked | 既有执行层 allowlist、removed/unavailable route 保留、catalogue 新增不自动授权均有回归测试。两个真实模型互作 parent/worker 的矩阵依赖 A06 和用户 profile。 |
| A09 | Blocked | 结构化 registry/HTTPS Git 安装、enable/disable/update/remove、revision 串行化、read-back、restart result、status/cancel 及注入拒绝已有测试。没有获准在真实 profile 安装安全测试 bundle；Git source 的 native latest 查询不存在，必须固定 ref。 |
| A10 | Blocked | 已只读盘点 `desktop` 自定义 bundle并记录 runtime/UI 边界。没有自动复制或安装；dynamic-subagents 在 `paseo` 的真实运行验证和用户所需 bundle 选择需要授权。 |
| A11 | Blocked | 全量自动化覆盖 streaming、reasoning、approvals、tools、skills、attachments、usage、session resume 和 subagent；Codex 未改。真实 Provider 回合、真实 skill 和生产 session 回归依赖 A06/用户授权。 |
| A12 | Blocked | 自动化 smoke 使用临时 DSH home；用户已在实际 `paseo` profile 配置 Z.AI，修复过程只读核对该 route。本地 Paseo 插件重载后 GLM 模型进入目录；Daemon restart persistence 尚未测试。 |
| A13 | Blocked | 同 profile 写操作在 Daemon 串行，DSH settings CAS 拒绝 stale draft；删除因跨进程依赖未知而强制明确确认；reload 文档要求从 active turn 外执行。真实 active session 并发编辑尚未授权。 |
| A14 | Blocked | 设置页使用 Paseo 跨平台 UI API，不使用 DOM/Node；host/profile/trust boundary 和 masked-only credential 状态可见。没有可用的已授权手机设备或远程 Paseo 连接进行验收。 |
| A15 | Blocked | settings 原生 CAS、写后 read-back、credential 部分失败、plugin 原生结果、保留 credential/session 和 Windows rollback 步骤已实现/记录。真实失败安装和原插件来源恢复没有授权执行。 |
| A16 | Pass | 当前门禁全部通过：373 tests，370 passed，3 skipped，0 failed；build、typecheck、notes、docs 和 diff checks 均通过。测试覆盖 management bridge、secret sanitization、revision binding、provider failure path、picker refresh、plugin lifecycle 和 Windows fixtures。 |

## 结论

实现满足可自动验证的架构、安全和回归条件，但不具备生产就绪结论。A02–A15 中需要真实写入、真实密钥、真实请求、真实 bundle 或远程设备的部分必须保持 `Blocked / Not tested`，直到用户逐项批准在 disposable profile 或指定环境中执行。
