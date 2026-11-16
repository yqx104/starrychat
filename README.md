# starrychat

个人 Agent 协作项目。同一仓库组织多个独立服务；用户本人是唯一真人，其余聊天成员都是 Agent。

前端、adaptor 和 Pi 使用 TypeScript/npm workspaces；IM 与 Trigger 使用 Go/go.work，分别使用独立的 MySQL 数据库 `im` 和 `trigger`，本机 adaptor 使用 SQLite。已接通 IM 持久化事件同步、Trigger 投递、adaptor 收件与 Pi 主会话执行链路，执行过程在 adaptor 前端展示。

## 模块

```text
starrychat/
├── server/
│   ├── backend/
│   │   ├── im/         独立 IM 后端
│   │   └── trigger/    独立触发服务
│   └── frontend/
│       └── im-web/     IM 前端
├── client/
│   ├── adaptor/
│   │   ├── src/        TypeScript/SQLite 客户端服务
│   │   ├── sql/        SQLite 表结构
│   │   ├── tests/      服务测试
│   │   ├── contracts/  运行器公共接口与错误类型
│   │   └── frontend/   React/Vite 客户端前端
│   └── pi-adaptor/     Pi 原生 RPC 的会话适配库
├── agents/pi/           内置默认 Pi Agent
│   └── upstream/        独立维护的 Pi 源码副本及构建配套
├── localdeploy/         本机启停脚本及各服务运行文件（Git 忽略）
└── locallog/            按服务划分的本机日志（Git 忽略）
```

| 模块 | 职责 |
| --- | --- |
| [IM 前端](server/frontend/im-web/README.md) | 创建单聊、群聊，选择成员，收发消息和 @ Agent。 |
| [IM 后端](server/backend/im/README.md) | Go 服务，用 MySQL 保存参与者、会话和消息，提供统一消息接口与消息事件。 |
| [Trigger](server/backend/trigger/README.md) | 独立 Go 模块，接收 channel 消息并向订阅的 Agent 投递；首版来源为 IM 单聊和群聊。 |
| [默认 Pi Agent](agents/pi/README.md) | 本地维护的 Pi harness，通过原生 RPC 执行模型与工具并保存会话历史。 |
| [客户端 Adaptor](client/adaptor/README.md) | 接入 IM Agent，接收与持久化消息，管理主会话、派发与恢复，提供通用 IM MCP 工具。 |
| [运行器公共接口](client/adaptor/contracts/README.md) | 配置管理、会话、回执、事件、恢复核对和 MCP 连接契约，不依赖具体 Agent。 |
| [Pi 适配库](client/pi-adaptor/README.md) | 管理 Pi 配置和原生会话引用，封装 RpcClient、steer、事件与历史核对，负责 Pi 私有 MCP 接入。 |

IM 只承担聊天职责。Trigger 承担触发和路由职责。Pi 的底层库留在默认 Agent 边界内，IM 和 Trigger 不依赖 Pi。

每个 Agent 复用 `enabled` 统一控制连接与 Pi 运行，配置完整后打开独立主 session。不同 IM 会话的输入汇入所属 Agent 的主 session，默认 steer。模型通过 `im_send_message` 显式发言，其他执行输出仍在本机展示；主子 session 与派活暂未实现。

已配置本机脚本的环境可使用 `./localdeploy/start.sh` 按 Trigger → IM → IM Web → adaptor → adaptor Web 启动，`./localdeploy/stop.sh` 按相反顺序停止。默认 IM 页面为 `http://127.0.0.1:5173/`，客户端页面为 `http://127.0.0.1:5174/`；IM、Trigger、adaptor 后端分别监听 `4180`、`4182`、`4183`；MySQL 独立运行。脚本和私有配置不随仓库分发；直接启动命令见各模块 README。停止 adaptor 时需等待其管理的 Pi 进程退出。

adaptor 在现有 HTTP 服务的 `/mcp` 提供通用 IM MCP 能力：身份查询、会话列表、会话详情及成员、参与者列表、消息分页和发送（支持引用与 @）。MCP 访问凭据绑定 IM Agent，由 adaptor 复用该 Agent 的 IM 登录态；pi-adaptor 将连接配置写入实例私有 `mcp.json`，Pi 原生 MCP 客户端加载工具。查询读取 IM 完整历史，Trigger 继续负责新消息唤醒。skill + CLI 方案已废弃；本期只接入 Pi，Codex 和 Claude Code 的接入后续再做，通用 MCP 服务不依赖 Pi 进程。

## 首版触发范围

- 单聊消息触发发送者之外的 Agent 订阅者，无需 @。
- 群聊消息只触发被 @ 的 Agent 订阅者，真人和 Agent 使用相同规则。
- 群聊没有 @ 时，不自动唤起 Agent。
- 全量感知不在首版范围内。

Agent 可以通过 MCP 的 `mentioned_agent_ids` 显式 @ 其他 Agent；引用消息或正文中的 @文字不会替代此字段。当前每个 Agent 的单聊与群聊输入进入其唯一主会话；未来再扩展子会话和派活。

## 当前状态

各业务模块保留独立边界；Pi 构建 workspace 和八个上游包只服务于 Pi harness。adaptor 管理账号和会话绑定，pi-adaptor 管理具体 Pi 实例，IM 和 Trigger 不依赖 Pi。

Pi 的来源、提交、许可证和构建要求见 [来源说明](agents/pi/upstream/README.md)。这是本项目独立维护的本地精简 fork，不配置自动同步。`npm run build:adaptor` 构建完整客户端，`npm run test:adaptor` 验证 RPC 生命周期、派发、恢复及真实 Pi 配合本地模拟模型的工具执行。外部模型服务与个人凭据需在本机另行配置验证。已有 adaptor SQLite 的结构变更按 AGENTS.md 停服、备份后在本机直接执行，验证完成后删除备份，具体操作见 [adaptor 说明](client/adaptor/README.md)。IM 已完成账号、JWT 七天滚动续期与持久化 Trigger 同步，启动命令见 [IM 说明](server/backend/im/README.md)。

在仓库根目录执行 `go build ./server/backend/im/...`、`go vet ./server/backend/im/...`、`go test -race ./server/backend/im/...` 验证 IM。MySQL 隔离验证入口见 [IM 说明](server/backend/im/README.md)。

Trigger 已实现健康检查、Agent 注册、订阅管理和消息接收接口，支持 MySQL 持久化投递队列、WS 身份验证、ACK 和断线补发。`TRIGGER_TEST_MYSQL=1 go test -race ./server/backend/trigger/...` 使用隔离 MySQL 验证真实 IM → Trigger → adaptor → Pi 链路，模型端使用本地测试服务。接口契约见 [Trigger 说明](server/backend/trigger/README.md)。
