# yqx-team

个人 Agent 协作项目。同一仓库组织多个独立服务；用户本人是唯一真人，其余聊天成员都是 Agent。

前端和 Pi 使用 TypeScript/npm workspaces；IM 与 Trigger 使用 Go/go.work，IM 数据库使用 MySQL。已完成默认 Pi 的最小运行验证，以及 IM 的 Handler、Service、Repository 和建表 SQL；协作系统尚不能启动。

## 模块

```text
yqx-team/
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
| [Trigger](backend/trigger/README.md) | 独立 Go 模块，接收 IM 消息事件，按规则选择目标 Agent 并唤起。 |
| [默认 Pi Agent](agents/pi/README.md) | 本地 Pi 已构建并通过会话验证；项目适配入口及 IM 对接尚未实现。 |

IM 只承担聊天职责。Trigger 承担触发和路由职责。Pi 的底层库留在默认 Agent 边界内，IM 和 Trigger 不依赖 Pi。

本机前后端统一使用 `./localdeploy/start.sh` 启动、`./localdeploy/stop.sh` 停止。前端地址为 `http://127.0.0.1:5173/`，IM 后端为 `http://127.0.0.1:4180/`；MySQL 独立运行。两个服务也可用各自 `localdeploy/im/`、`localdeploy/im-web/` 下的脚本单独管理，日志分别写入 `locallog/im/`、`locallog/im-web/`。

各 Agent 将通过统一 IM CLI 收发和列出消息，CLI 访问 IM 后端。外部 Agent 只需能执行 CLI 并访问 IM，无需导入 Pi SDK。Trigger 向不同 harness 投递任务由各自适配入口承接，是另一条链路；首版不引入 ACP。上述 CLI 和适配入口均尚未实现。

## 首版触发范围

- 用户在单聊发送消息，直接触发对方 Agent，无需 @。
- 用户在群聊发送消息，只触发被 @ 的一个或多个 Agent。
- 群聊没有 @ 时，不自动唤起 Agent。
- 全量感知不在首版范围内。

是否允许 Agent 发出的 @ 触发其他 Agent，尚未确定。Agent 身份、IM 会话与模型上下文的映射方式也留待后续设计，没有运行实现。

## 当前状态

四个业务模块保留独立边界；默认 Pi 模块已经声明本地源码依赖，但没有项目运行入口。新增的 Pi 构建 workspace 和八个上游包只服务于默认 Pi Agent。目录结构不决定服务部署方式。

Pi 的来源、提交、许可证、运行命令及验证边界见 [来源说明](agents/pi/upstream/README.md)。这是一份由本项目独立维护的本地精简 fork，不配置自动同步。依赖、模型目录数据和八包构建产物已就绪；本地 CLI 返回版本，真实 SDK 会话提交最小输入后正常返回缺少认证错误，并成功释放。未发出真实模型请求，模型调用成功与否未验证。IM 已实现 Handler、Service、MySQL Repository、账号注册、JWT 登录与七天滚动续期，并提供真实 HTTP 监听及本机持久化启动方式；Trigger 规则、统一 IM CLI 和 Agent 适配器仍未接入。启动命令见 [IM 说明](backend/im/README.md)。

在仓库根目录执行 `go build ./backend/im/...`、`go vet ./backend/im/...`、`go test -race ./backend/im/...` 验证 IM。MySQL 隔离验证入口见 [IM 说明](backend/im/README.md)。
