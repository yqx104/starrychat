# 本机 Adaptor

TypeScript 后端使用 SQLite 保存接入的 IM Agent 和本机收件箱；React/Vite 前端通过同源 `/adaptor-api` 代理调用后端。每个启用的 Agent 有一条到 Trigger 的 WS/WSS 连接。浏览器关闭不会停止后端接收。

本版完成账号接入、连接状态、启停与重新认证、消息落盘 ACK、去重和离线重连补发。所有收件记录保持 `pending`；`client/pi-adaptor` 的模型和工具执行尚未接入。Agent 登记、会话订阅、退订、解散和消息都通过 IM 的持久化队列自动同步到 Trigger，消息再经 WS 投递到 adaptor。

## 本机运行

需要 Node.js 24 或更高版本，使用内置 `node:sqlite`。在仓库根安装依赖并构建：

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run build --workspace=@starrychat/adaptor-backend
npm run build --workspace=@starrychat/adaptor-web
```

私有配置放在 `localdeploy/adaptor/config.json`，权限 `0600`，目录权限 `0700`：

```json
{
  "address": "127.0.0.1:4183",
  "im_base_url": "http://127.0.0.1:4180",
  "trigger_ws_url": "ws://127.0.0.1:4182/agent-connections",
  "adaptor_id": "本机首次生成并保留的实例标识",
  "sqlite_path": "adaptor.sqlite"
}
```

SQLite 路径相对于配置文件。首次创建空库需要显式执行以下命令，已存在的数据库会被拒绝；服务启动只检查表结构，不自动建表或改表：

```sh
node client/adaptor/backend/src/init-db.ts "$PWD/localdeploy/adaptor/config.json"
node client/adaptor/backend/dist/main.js "$PWD/localdeploy/adaptor/config.json"
```

另一个终端启动前端：

```sh
ADAPTOR_API_TARGET=http://127.0.0.1:4183 npm run dev --workspace=@starrychat/adaptor-web
```

本机已经配置 `localdeploy/adaptor/{start,stop,status}.sh` 和 `localdeploy/adaptor-web/{start,stop,status}.sh`，也可用根目录的统一启停脚本。页面地址 `http://127.0.0.1:5174/`，后端 `http://127.0.0.1:4183/`。日志分别写入 `locallog/adaptor/adaptor.log` 和 `locallog/adaptor-web/adaptor-web.log`。这些运行文件被 Git 忽略，不随仓库分发；启动脚本不执行 SQL。

## 数据和鉴权

完整表结构在 [backend/sql/schema.sql](backend/sql/schema.sql)：

- `agents`：IM 身份、显示名与用户名缓存、短期 Bearer Token、到期时间、启用设置和时间戳。账号密码仅用于登录，不落盘；MVP 的 Token 保存在私有 SQLite 文件内，不返回给浏览器。
- `inbox`：本地递增 ID、接收 Agent、消息 ID、channel ID、完整消息 JSON、`pending` 状态和接收时间。`(agent_id, message_id)` 唯一；本地 ID 用于分页，不代表跨 IM 会话的原始消息顺序。

后端把账号交给 IM 登录，确认 `kind=agent` 后使用 IM 返回的 ID，不允许客户端自行指定身份。Trigger 在每次 WS 握手时调用 IM `/auth/me` 验证身份，并通过 `ready` 帧将 IM 续签的 Token 返回给本机后端保存。客户端到期前重连续签，过期的凭据需要重新认证；Trigger 到期关闭连接。当前继承 IM 的七天滚动有效期和撤销能力，不新增设备授权体系。

在线状态保存在进程内存中。`enabled` 才是数据库中的连接意图，重启后重新建立连接。Trigger 单实例内，同一 Agent 同时只能有一条活动连接；冲突时展示状态并重试。`adaptor_id` 是本机实例标识，不授予账号权限。

## HTTP 接口

浏览器访问以下路径时加 `/adaptor-api` 前缀。后端只监听环回地址，写操作使用 JSON，浏览器请求要求同源。

| 方法与路径 | 请求／响应 |
| --- | --- |
| `GET /healthz` | SQLite 可用时返回 `{status:"ok"}` |
| `GET /config` | 返回 `adaptor_id`、`im_base_url`、`trigger_ws_url` |
| `GET /agents` | 返回 `{agents}`，不含 Token，附带连接状态、连接时间和最近错误 |
| `POST /agents` | `{username,password}`；成功 `201 {agent}`，默认启用；重复接入返回 `409` |
| `PATCH /agents/{id}` | `{enabled:boolean}`；返回 `{agent}` |
| `POST /agents/{id}/reauthenticate` | `{username,password}`；必须是同一 IM Agent，返回 `{agent}` |
| `GET /agents/{id}/inbox` | 可选 `before_id`、`limit`（默认 50，最大 100）；返回 `{messages,has_more}`，按本地 ID 降序 |

连接状态为 `disabled`、`connecting`、`online`、`reconnecting`、`auth_required` 或 `conflict`。停用不会删除收件记录或云端账号。前端每两秒轮询状态和当前页。

## 投递约定

Trigger `GET /agent-connections` 接受 Bearer 身份凭据。协议帧为：

```text
ready    {agent_id, token, expires_at}       Trigger → adaptor
delivery {agent_id, channel_id, message}     Trigger → adaptor
ack      {message_id}                       adaptor → Trigger
```

客户端先提交 SQLite 写入，再发送 ACK。重复消息只补发 ACK；写入失败会断开，等待 Trigger 重发。Trigger 对每个 Agent 的每个 channel 独立投递：从已入库消息中按 `message_seq` 取未确认队首，每个 channel 最多一条在途，收到 ACK 后再推进；不同 channel 共用 WS，各自等待 ACK 和重试。五秒未确认则重发，十五秒发一次 Ping，四十五秒无 Pong 断开。客户端断线后每两秒重连。ACK 只表示本机接收成功，不表示 Pi 已执行。

## 验证

```sh
npm test --workspace=@starrychat/adaptor-backend
TRIGGER_TEST_MYSQL=1 go test -race ./server/backend/trigger/...
```

Node 测试使用真实临时 SQLite，检查写入失败不 ACK、补发去重和重新打开后的持久化。Go 集成测试使用仓库外的隔离 MySQL、真实 IM 服务、Trigger WS 和 Node adaptor，从 IM 建会话、成员变更和发消息接口验证账号接入、订阅同步、群聊 @、鉴权拒绝、单连接约束、落盘 ACK、ACK 丢失重发、停用、三端重启、IM 待同步消息恢复、自动重连和凭据到期关闭。所有测试账号与消息仅存在于临时测试库。
