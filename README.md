# starrychat

个人 Agent 协作项目。同一仓库组织多个独立服务；用户本人是唯一真人，其余聊天成员都是 Agent。

前端和 Pi 使用 TypeScript/npm workspaces；IM 与 Trigger 使用 Go/go.work，分别使用独立的 MySQL 数据库 `im` 和 `trigger`。已完成默认 Pi 的最小运行验证、IM 的 Handler、Service、Repository，以及 Trigger 的注册、订阅和消息接口；Agent 协作链路尚未接通。

## 模块

```text
starrychat/
├── frontend/im-web/     IM 前端
├── backend/im/          独立 IM 后端
├── backend/trigger/     独立触发服务
├── agents/pi/           内置默认 Pi Agent
│   └── upstream/        独立维护的 Pi 源码副本及构建配套
├── localdeploy/         本机启停脚本及各服务运行文件（Git 忽略）
└── locallog/            按服务划分的本机日志（Git 忽略）
```

| 模块 | 职责 |
| --- | --- |
| [IM 前端](frontend/im-web/README.md) | 创建单聊、群聊，选择成员，收发消息和 @ Agent。 |
| [IM 后端](backend/im/README.md) | Go 服务，用 MySQL 保存参与者、会话和消息，提供统一消息接口与消息事件。 |
| [Trigger](backend/trigger/README.md) | 独立 Go 模块，接收 channel 消息并向订阅的 Agent 投递；首版来源为 IM 单聊和群聊。 |
| [默认 Pi Agent](agents/pi/README.md) | 本地 Pi 已构建并通过会话验证；项目适配入口及 IM 对接尚未实现。 |

IM 只承担聊天职责。Trigger 承担触发和路由职责。Pi 的底层库留在默认 Agent 边界内，IM 和 Trigger 不依赖 Pi。

本机服务统一使用 `./localdeploy/start.sh` 按 Trigger → IM → IM Web 启动，`./localdeploy/stop.sh` 按相反顺序停止。前端地址为 `http://127.0.0.1:5173/`，IM 为 `http://127.0.0.1:4180/`，Trigger 为 `http://127.0.0.1:4182/`；MySQL 独立运行。各服务可通过 `localdeploy/<服务名>/` 下的脚本单独管理，日志写入各自的 `locallog/<服务名>/`。

各 Agent 将通过统一 IM CLI 收发和列出消息，CLI 访问 IM 后端。外部 Agent 只需能执行 CLI 并访问 IM，无需导入 Pi SDK。Trigger 向不同 harness 投递任务由各自适配入口承接，是另一条链路；首版不引入 ACP。上述 CLI 和适配入口均尚未实现。

## 首版触发范围

- 单聊消息触发发送者之外的 Agent 订阅者，无需 @。
- 群聊消息只触发被 @ 的 Agent 订阅者，真人和 Agent 使用相同规则。
- 群聊没有 @ 时，不自动唤起 Agent。
- 全量感知不在首版范围内。

Agent 可以 @ 其他 Agent，协作行为由后续 skill 约束。Agent 身份、IM 会话与模型上下文的映射方式留待 Agent 运行器接入时设计。

## 当前状态

四个业务模块保留独立边界；默认 Pi 模块已经声明本地源码依赖，但没有项目运行入口。新增的 Pi 构建 workspace 和八个上游包只服务于默认 Pi Agent。目录结构不决定服务部署方式。

Pi 的来源、提交、许可证、运行命令及验证边界见 [来源说明](agents/pi/upstream/README.md)。这是一份由本项目独立维护的本地精简 fork，不配置自动同步。依赖、模型目录数据和八包构建产物已就绪；本地 CLI 返回版本，真实 SDK 会话提交最小输入后正常返回缺少认证错误，并成功释放。未发出真实模型请求，模型调用成功与否未验证。IM 已实现 Handler、Service、MySQL Repository、账号注册、JWT 登录与七天滚动续期，并提供真实 HTTP 监听及本机持久化启动方式；IM 到 Trigger 的调用、统一 IM CLI 和 Agent 适配器仍未接入。启动命令见 [IM 说明](backend/im/README.md)。

在仓库根目录执行 `go build ./backend/im/...`、`go vet ./backend/im/...`、`go test -race ./backend/im/...` 验证 IM。MySQL 隔离验证入口见 [IM 说明](backend/im/README.md)。

Trigger 已实现健康检查、Agent 注册、批量订阅、单个退订、会话清理和消息接收接口，支持向配置的 HTTP Agent 适配入口投递。IM 调用链和实际 Agent 接收入口尚未接通，接口契约与验证命令见 [Trigger 说明](backend/trigger/README.md)。
