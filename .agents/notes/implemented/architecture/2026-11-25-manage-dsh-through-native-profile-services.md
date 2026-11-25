# 决策记录: 通过 DSH 原生 profile 服务提供管理能力

Status: implemented

## 问题

Paseo 需要管理 DSH 的模型提供方、模型、凭证和运行时插件，同时 DSH 仍须是配置事实来源。另存一份 Paseo 配置会产生漂移；直接改 YAML 会绕过 schema、并发控制和热加载；私有 Desktop RPC 又依赖桌面认证细节。

## 决定

管理页通过与会话相同的有效 executable 和 profile 启动短生命周期 bridge。提供方与模型只经 `llm-pi-ai` 的可写设置 namespace 读写，使用 `settings.describe({ redactSecrets: true })`、revision 和 `settings.mutate()`；凭证只经 `credentials.describe/set/unset`，完整已存值不跨 bridge。插件操作只调用 DSH `pluginManager` 的结构化 lifecycle 方法。

Paseo RPC 的 revision 同时绑定有效 executable、profile、DSH home 和配置内容。写操作按 profile 串行，写后重新读取 DSH 状态；provider 变化随后刷新 Paseo 模型目录。settings 与 credential 是两个原生提交阶段，第二阶段失败时返回部分成功，而不把第一阶段伪装成已回滚。活动会话依赖无法由独立 bridge 完整观察时，删除操作明确报告未知并要求确认。

## 考虑过的其他做法

- **把 provider、model 和 key 存进 Paseo plugin settings**：表单简单，但会建立第二个事实来源，并让密钥进入不属于 DSH 的存储，放弃。
- **直接解析和覆盖 profile YAML**：可以绕过服务版本差异，但会丢失未知字段、并发 revision、schema 校验和 HMR 语义，放弃。
- **复用 DSH Desktop 私有 RPC 或认证 token**：能复刻桌面设置页，但会把插件绑到私有认证和 Desktop 生命周期，放弃。
- **向客户端暴露通用 package-manager 命令**：覆盖面大，但会形成任意命令执行入口，放弃；安装来源改为 registry package 或 HTTPS Git 的结构化输入。

## 后果

管理状态继续由选中的 DSH profile 持有，现有 Direct Provider、session ID 和模型切换链路不变。凭证存储属于同一 DSH home 而不是单个 profile，共用 ref 的轮换可能影响其他 profile，界面必须提示。provider 设置可热加载，凭证在后续请求重新解析；插件则按原生结果区分立即应用与需要重启。

短 bridge 不能可靠枚举其他 DSH 进程中的活动 agent，因此 provider 删除采用保守确认，不能声称已证明无依赖。真实 inference、真实插件安装和手机端远程操作仍需用户授权的环境验收。

## 怎么验证的

共享 schema 和 bridge 双层校验覆盖 secret 字符、provider id、registry/Git 安装来源与额外字段。服务端测试覆盖 configured/addable 分离、失效 route 的模型回显、revision 冲突、credential 部分失败、删除确认、命令注入拒绝，以及 executable/profile 切换后的旧草稿拒绝。Windows bundled DSH `0.2.3-alpha.2` 使用临时 DSH home 完成 bridge smoke；生产 profile 只读。

候选提交 `70cc625` 完成四路独立 simplify。

- 服务端审查促成异步插件 status/cancel 脱离 bundle revision、删除重复 snapshot 和收窄 host contract。
- 客户端审查促成 credential destination 快照确认、持续 operation polling、删除目标绑定及完整 metadata 编辑。
- 契约审查合并 provider/plugin operation schema 并删除死字段。
- 综合审查补出 runtime metadata 与 provider 专属 model 字段的保留，以及 credential unset 的真实 native 调用。

主 agent 落实全部正确性项；未采纳会增加动态分派或 DSH runtime 依赖的改写。服务端和客户端 reviewer 对整改版本复核通过。

### 独立复核

最终代码候选提交是 `7789ee8`。独立 code review 发现并推动六项加固：revision 绑定 canonical `value`、`base`、`user` 内容；runtime catalogue 只补全已配置模型；Git source 同时在共享 schema 和 bridge 边界拒绝 credential、query 与 fragment；异步插件 status/cancel 保留创建 request 的 bridge；provider 删除与模型目录刷新分开报告部分成功；credential 部分失败后客户端采用服务端返回的新 revision。修正后的复核没有剩余阻断或高优先级问题。

独立 test/acceptance audit 核对 A02、A05、A09 和 A16 的实现、测试与文案。补齐插件 `true → false` toggle 测试，并把模型目录刷新准确限定为已接线且通过 typecheck；最终复核没有证据不一致。全量结果是 367 tests、364 passed、3 skipped、0 failed，定向管理测试 13/13 通过。
