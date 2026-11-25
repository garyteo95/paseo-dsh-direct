# DSH 管理

DeepSeek Harness 设置页通过 Paseo Daemon 主机上的 DSH 原生服务管理当前有效 profile。有效 profile 仍按 `PASEO_DSH_PROFILE`、插件设置、默认 `paseo` 的顺序选择；页面显示 Paseo host 与 profile。provider、model、credential 和 bundle 不另存进 Paseo plugin settings。

## 模型提供方与模型

`Model providers` 读取 `llm-pi-ai` 的实际配置和 DSH 的 configurable-provider 目录。已安装的 Z.AI 与 OpenCode Go 入口优先显示，其他目录条目可按需展开；通用 `Add a custom model API` 仍可使用。新增 provider 必须配置至少一个模型，通用自定义 provider 还须填写协议和 base URL。新建目标 provider 时直接显示密钥输入。可新增、编辑和删除 provider，编辑模型的 ID、名称、context window、max output tokens、输入类型和 reasoning levels。provider ID 创建后保持稳定。目录支持时可读取模型列表；不支持 discovery 时可手工维护模型。

配置写入带 DSH revision。并发修改会拒绝旧草稿；成功写入后页面重新读取 DSH 并刷新 Paseo 的 `dsh-pi` 模型目录。provider 设置属于 volatile 配置，活动 DSH 进程通过 HMR 收敛；页面只在 read-back 后报告设置已保存。删除 provider 时，短生命周期管理 bridge 无法证明其他 DSH 进程没有活动依赖，因此必须确认，正在运行的回合不应被中断。

`Check DSH model catalogue` 使用 DSH 的 model discovery 核对模型注册。已安装的 catalogue provider 可直接返回本地数据，不发网络请求；成功不证明 endpoint、凭证或 Coding Plan 权限可用。错误只返回分类后的 invalid credential、unreachable endpoint、incompatible protocol、unavailable model、rate limit、unsupported 或 unknown。真实模型测试可能计费，须在用户授权后另行执行。

## 凭证

已存密钥只通过 DSH `credentials.describe()` 返回 configured、writable、source 和 host 生成的 masked preview；完整值不会返回客户端。新增或轮换只把当前输入一次发送到 `credentials.set()`，不会进入 plugin settings、日志或 RPC 响应。provider 配置与 credential 是两个原生提交阶段；配置成功但 credential 失败时，页面明确显示部分成功并要求刷新后只重试凭证。

credential store 属于同一个 DSH home，不按 profile 隔离。复用同一 credential ref 可避免重复保存，但轮换该 ref 也会影响其他 profile。Windows 上文件保护依赖主机 ACL。只应通过已认证、受保护的 Paseo 连接远程输入密钥；任何获授权控制该 Daemon 的客户端都处于同一管理信任边界。

## DSH plugins

`DSH plugins` 与 Paseo 自己的插件管理器分开。页面列出当前 profile 的 bundle、版本、启用状态、更新能力、错误和应用结果。DSH 未报告更新版本时，页面显示未知，不把它误报为已是最新版；registry bundle 仍可显式要求 DSH 检查并更新。安装只接受结构化的 registry package 或不含 userinfo、query、fragment 的 HTTPS Git source；服务端不接受 pnpm 参数、shell 命令、本地 tarball 路径或任意 argv。启用、禁用、更新和删除均调用 DSH `pluginManager`，同一 profile 的变更串行，并显示 `applied`、`restart-required`、`overridden`、`failed` 或 `cancelled`。异步操作的 status/cancel 复用创建 request ID 的同一 bridge；插件进程重启后不伪装成仍可取消，页面改为要求刷新实际 bundle 状态。

bundle 注册的 DSH browser 组件不会自动成为 Paseo UI。运行时插件可以在 Paseo 启动的 DSH 中工作；仅提供 toast、Desktop Notification、Dock badge 等 DSH client 功能的 bundle 在 Paseo 中没有对应呈现。Git bundle 没有原生“最新版本”查询，更新需要调用方提供同仓库的固定 commit。

## 安装、验证与回滚

在 fork 的 checkout 上运行：

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run verify:notes
npm run verify:docs
```

本地源码安装前先记录当前插件来源或版本。Windows PowerShell 中从仓库 checkout 安装：

```powershell
Set-Location 'C:\path\to\paseo-dsh-direct'
npm ci
npm run build
paseo plugin install (Get-Location).Path
paseo plugin ls --json
paseo provider models dsh-pi
```

后续更新同一 checkout 时先确认没有正在执行的 `dsh-pi` 回合，再运行：

```powershell
Set-Location 'C:\path\to\paseo-dsh-direct'
npm run build
paseo plugin reload paseo-dsh-direct
paseo plugin ls --json
paseo provider diagnostic dsh-pi
```

不要同时加载两个注册 `dsh-pi` 的副本。回滚时把 `<recorded-source>` 换成安装前记录的 npm 或 Git source：

```powershell
paseo plugin install '<recorded-source>'
paseo plugin ls --json
paseo provider diagnostic dsh-pi
```

重载和恢复来源会停止旧 Provider 连接，因此应从会话外执行；持久 session 随后可恢复，正在执行的工具不能视为完成。DSH session 和 credential store 不随插件来源恢复而删除。provider 或 bundle 的原生变更属于 DSH profile，须在回滚前从管理页撤销或用 DSH 自己的受支持管理界面恢复。完整 CLI 语义见[开发与验证](plugin-guide.md)。

自动化使用临时 `DSH_HOME` 和合成凭证。真实 OpenCode Go、Z.AI、第三方 bundle、远程手机端及用户自定义插件只在用户授权后验证，未执行时必须标为 Blocked / Not tested。

逐项结果见 [DSH 管理验收](dsh-management-acceptance.md)。
