# 内置默认 Pi Agent

项目默认 Agent 的独立模块，已在 [upstream/](upstream/README.md) 纳入 Pi 的三个核心包、五个必要内部依赖及构建配套。此副本作为本项目独立维护的本地精简 fork，不配置自动同步。

现由 [adaptor](../../client/adaptor/README.md) 接收 Trigger 投递并落盘，通过 [pi-adaptor](../../client/pi-adaptor/README.md) 将输入默认以 steer 提交到 Agent 的 Pi 主会话。一个启用且配置完整的 Agent 对应一个独立 Pi RPC 进程；单聊和群聊共用其主会话。执行输出在 adaptor 展示，统一 IM CLI、IM 发言及主子 session 留待后续实现。外部 Agent 无需使用本模块，首版不引入 ACP。

内部主要使用 pi-ai、pi-agent-core、pi-coding-agent 及其所需依赖。这些是默认 Pi Agent 内部的库，不是三个业务服务，也不成为其他外部 Agent 的依赖要求。

运行入口使用本地构建的 `upstream/packages/coding-agent/dist/bundle/rpc-entry.js`，通过现成 RpcClient 控制。运行 `npm run build:adaptor` 可按顺序构建 Pi、适配库、adaptor 后端与前端。Pi 会话历史由 Pi 自己管理，精确 ID／文件路径绑定保存在 adaptor SQLite。

本 workspace 使用 `@starrychat/pi-agent` 名称，通过 `file:` 路径依赖本地 pi-ai、pi-agent-core、pi-coding-agent。项目根注册八个 Pi 包，包间也直接使用本地 `file:` 路径；保留的上游 `1.5.0` 字段不代表采用 npm 发布内容。安装时实际核对了八个包均链接到本目录的源码。

2026-11-08 已安装必要依赖、生成公开模型目录数据并完成八包构建。本地 CLI 返回 `1.5.0`；隔离 SDK 会话创建成功，提交 `Hello` 后通过真实 Anthropic 认证检查返回 `No API key found for anthropic.`，随后会话恢复空闲并释放，未发出网络请求。模型成功调用未验证，也未运行完整测试套件。

可复用命令和隔离验证说明见 [本地运行说明](upstream/README.md)。源码清单、逐文件校验值及配置调整见 [导入清单](upstream/UPSTREAM-MANIFEST.json)；没有改动上游包的运行逻辑。

2026-11-14 的 MVP 验证补充：真实 Pi RPC 已通过本地 OpenAI 兼容模拟服务完成模型流式响应、工具执行、插队和持久化恢复验证，并纳入 IM → Trigger → adaptor 的隔离集成测试。没有调用外部付费模型服务。构建时 Radius 的在线目录受网络策略限制，使用 npm `@earendil-works/pi-ai@1.5.0` 发布产物中的 Radius 目录快照与其他在线目录一起生成并校验本地数据；仅使用数据，执行源码仍为仓库内固定版本。
