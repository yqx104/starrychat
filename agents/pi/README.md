# 内置默认 Pi Agent

项目默认 Agent 的独立模块，已在 [upstream/](upstream/README.md) 纳入 Pi 的三个核心包、五个必要内部依赖及构建配套。此副本作为本项目独立维护的本地精简 fork，不配置自动同步。

后续由适配入口接受 [Trigger](../../backend/trigger/README.md) 唤起，通过统一 IM CLI 访问 [IM 服务](../../backend/im/README.md)，收发和列出消息。具体唤起协议、CLI 和上下文映射尚未实现。外部 Agent 无需使用本模块，首版不引入 ACP。

内部主要使用 pi-ai、pi-agent-core、pi-coding-agent 及其所需依赖。这些是默认 Pi Agent 内部的库，不是三个业务服务，也不成为其他外部 Agent 的依赖要求。

上游源码已包含无界面 SDK、自定义工具、会话管理和 RPC；项目的默认 Agent 运行入口与 IM 适配仍未实现。

本 workspace 使用 `@starrychat/pi-agent` 名称，通过 `file:` 路径依赖本地 pi-ai、pi-agent-core、pi-coding-agent。项目根注册八个 Pi 包，包间也直接使用本地 `file:` 路径；保留的上游 `1.5.0` 字段不代表采用 npm 发布内容。安装时实际核对了八个包均链接到本目录的源码。

2026-11-08 已安装必要依赖、生成公开模型目录数据并完成八包构建。本地 CLI 返回 `1.5.0`；隔离 SDK 会话创建成功，提交 `Hello` 后通过真实 Anthropic 认证检查返回 `No API key found for anthropic.`，随后会话恢复空闲并释放，未发出网络请求。模型成功调用未验证，也未运行完整测试套件。

可复用命令和隔离验证说明见 [本地运行说明](upstream/README.md)。源码清单、逐文件校验值及配置调整见 [导入清单](upstream/UPSTREAM-MANIFEST.json)；没有改动上游包的运行逻辑。
