# starrychat

个人 Agent 协作项目。同一仓库组织多个独立服务；用户本人是唯一真人，其余聊天成员都是 Agent。

前端、adaptor 和 Pi 使用 TypeScript/npm workspaces；IM 与 Trigger 使用 Go/go.work，分别使用独立的 MySQL 数据库 `im` 和 `trigger`，本机 adaptor 使用 SQLite。已完成 IM 基础服务、Trigger 路由和客户端接收链路；IM 到 Trigger 的事件同步与 Pi 实际执行尚未接通。

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
│   │   ├── backend/    TypeScript/SQLite 客户端后端
│   │   └── frontend/   React/Vite 客户端前端
│   └── pi-adaptor/     Pi 适配器（占位）
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
| [默认 Pi Agent](agents/pi/README.md) | 本地 Pi 已构建并通过会话验证；项目适配入口及 IM 对接尚未实现。 |
| [客户端 Adaptor](client/adaptor/README.md) | 接入 IM Agent 账号，连接 Trigger，保存消息、落盘确认、去重和断线补发。 |

IM 只承担聊天职责。Trigger 承担触发和路由职责。Pi 的底层库留在默认 Agent 边界内，IM 和 Trigger 不依赖 Pi。

`client/adaptor` 已实现最小接收端；`client/pi-adaptor` 保留占位，现有 Pi harness 源码仍位于 `agents/pi/`。收件箱中的消息保持待执行状态。

本机服务统一使用 `./localdeploy/start.sh` 按 Trigger → IM → IM Web → adaptor → adaptor Web 启动，`./localdeploy/stop.sh` 按相反顺序停止。IM 页面为 `http://127.0.0.1:5173/`，客户端页面为 `http://127.0.0.1:5174/`；IM、Trigger、adaptor 后端分别监听 `4180`、`4182`、`4183`；MySQL 独立运行。各服务可通过 `localdeploy/<服务名>/` 下的脚本单独管理，日志写入各自的 `locallog/<服务名>/`。

各 Agent 将通过统一 IM CLI 收发和列出消息，CLI 访问 IM 后端。外部 Agent 只需能执行 CLI 并访问 IM，无需导入 Pi SDK。Trigger 已能通过 WebSocket 向本机 adaptor 投递任务；统一 IM CLI 和 harness 执行入口尚未实现，首版不引入 ACP。

## 首版触发范围

- 单聊消息触发发送者之外的 Agent 订阅者，无需 @。
- 群聊消息只触发被 @ 的 Agent 订阅者，真人和 Agent 使用相同规则。
- 群聊没有 @ 时，不自动唤起 Agent。
- 全量感知不在首版范围内。

Agent 可以 @ 其他 Agent，协作行为由后续 skill 约束。Agent 身份、IM 会话与模型上下文的映射方式留待 Agent 运行器接入时设计。

## 当前状态

各业务模块保留独立边界；默认 Pi 模块已经声明本地源码依赖，但没有项目执行入口。Pi 构建 workspace 和八个上游包只服务于默认 Pi Agent。目录结构不决定服务部署方式。

Pi 的来源、提交、许可证、运行命令及验证边界见 [来源说明](agents/pi/upstream/README.md)。这是一份由本项目独立维护的本地精简 fork，不配置自动同步。依赖、模型目录数据和八包构建产物已就绪；本地 CLI 返回版本，真实 SDK 会话提交最小输入后正常返回缺少认证错误，并成功释放。未发出真实模型请求，模型调用成功与否未验证。IM 已实现 Handler、Service、MySQL Repository、账号注册、JWT 登录与七天滚动续期，并提供真实 HTTP 监听及本机持久化启动方式；IM 到 Trigger 的调用、统一 IM CLI 和 Pi 执行仍未接入。启动命令见 [IM 说明](server/backend/im/README.md)。

在仓库根目录执行 `go build ./server/backend/im/...`、`go vet ./server/backend/im/...`、`go test -race ./server/backend/im/...` 验证 IM。MySQL 隔离验证入口见 [IM 说明](server/backend/im/README.md)。

Trigger 已实现健康检查、Agent 注册、订阅管理和消息接收接口，支持 MySQL 持久化投递队列、WS 身份验证、ACK 和断线补发。IM 调用链尚未接通，接口契约与验证命令见 [Trigger 说明](server/backend/trigger/README.md)。
