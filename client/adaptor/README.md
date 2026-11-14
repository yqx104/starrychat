# 本机 Adaptor

TypeScript 后端使用 SQLite 保存接入的 IM Agent 和本机收件箱；React/Vite 前端通过同源 `/adaptor-api` 代理调用后端。每个启用的 Agent 有一条到 Trigger 的 WS/WSS 连接。浏览器关闭不会停止后端接收。

本版完成账号接入、连接状态、启停与重新认证、消息落盘 ACK、去重和离线重连补发，并通过 [pi-adaptor](../pi-adaptor/README.md) 接入 Pi 主会话。Agent 登记、会话订阅、退订、解散和消息通过 IM 的持久化队列同步到 Trigger，消息经 WS 投递到 adaptor，再由 Dispatcher 默认以 `steer` 提交到该 Agent 的主会话。文本、工具活动和错误在本机页面展示；主子 session 和 IM 发言不在本期范围内。

## 后端目录与职责

后端源码位于 `backend/src/`，按职责分层：

| 目录 | 职责 |
| --- | --- |
| `cmd/` | `main.ts` 组装服务并管理启停；`init-db.ts` 显式初始化空库。 |
| `config/` | 读取配置、校验配置项和解析本机路径。 |
| `http/` | 请求解析、路由分发、响应与错误处理；账号和会话接口分别维护。 |
| `service/` | 账号接入与启停、会话生命周期与恢复、输入派发，以及收件落盘后 ACK 的业务协调。 |
| `repository/` | SQLite 访问、收件去重和原子状态更新。 |
| `clients/` | IM HTTP 调用、Trigger WS 连接/心跳/重连/协议收发和 Pi 会话工厂。 |
| `model/` | 内部共享数据类型和业务错误。 |

HTTP 层调用业务层，业务层使用存储层和外部客户端；客户端不访问 SQLite。Trigger 客户端通过回调交付消息，`service/connections.ts` 先完成落盘，再调用客户端发送 ACK，最后唤醒派发器。`sql/schema.sql` 继续保存当前完整结构，测试位于 `backend/tests/`。

## 本机运行

需要 Node.js 24 或更高版本，使用内置 `node:sqlite`。在仓库根安装依赖并构建：

```sh
npm install --ignore-scripts --no-audit --no-fund
# 首次构建且缺少模型目录数据时执行（需要访问公开模型目录）
npm run hydrate:model-data --workspace=@starrychat/pi-upstream
npm run build:adaptor
```

私有配置放在 `localdeploy/adaptor/config.json`，权限 `0600`，目录权限 `0700`：

```json
{
  "address": "127.0.0.1:4183",
  "im_base_url": "http://127.0.0.1:4180",
  "trigger_ws_url": "ws://127.0.0.1:4182/agent-connections",
  "adaptor_id": "本机首次生成并保留的实例标识",
  "sqlite_path": "adaptor.sqlite",
  "data_root": "runtime"
}
```

SQLite 和 `data_root` 路径相对于配置文件。Pi 默认运行仓库内 `agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js`；可用本机配置 `pi_cli_path` 指定其他构建路径。首次创建空库需要显式执行以下命令，已存在的数据库会被拒绝；服务启动只检查表结构，不自动建表或改表：

```sh
node client/adaptor/backend/src/cmd/init-db.ts "$PWD/localdeploy/adaptor/config.json"
node client/adaptor/backend/dist/cmd/main.js "$PWD/localdeploy/adaptor/config.json"
```

另一个终端启动前端：

```sh
ADAPTOR_API_TARGET=http://127.0.0.1:4183 npm run dev --workspace=@starrychat/adaptor-web
```

页面地址 `http://127.0.0.1:5174/`，后端 `http://127.0.0.1:4183/`。`localdeploy/` 和 `locallog/` 是 Git 忽略的本机运行目录，不随仓库分发；如果使用本机启停脚本，启动前完成构建与数据库准备，停止时向 adaptor 发送 SIGTERM 并等待退出，不能提前关闭数据库或只杀父进程。后端会先停止接收与派发、中止并关闭 Pi，再关闭 SQLite。

已有 SQLite 结构需要变更时，按 [AGENTS.md](../../AGENTS.md) 的约定操作：

1. 核对目标数据库并停止所有访问该库的应用服务。
2. 将需要保留的账号、凭据和消息等数据备份到仓库外的本机私有目录。
3. 使用本机 SQLite 管理连接直接执行必要的结构变更和配套 SQL，保留消息本地 ID 和去重约束。
4. 同步更新 `backend/sql/schema.sql`、受影响的代码和测试；该文件只保存当前完整结构，供阅读和新建空库使用。
5. 重新构建并启动服务，验证数据库结构、服务启动及受影响接口。
6. 验证完成后删除之前的备份，这是必须完成的步骤。

仓库不维护迁移脚本、迁移目录、迁移版本记录或迁移框架。启动只检查当前结构，不自动建表或改表；结构不匹配时拒绝启动并提示按上述流程处理。

## Pi 配置与生命周期

接入账号后，在页面的“运行配置”中填写工作目录和 Pi 私有配置目录，可选填 provider/model（两者同时填写）和扩展绝对路径。只支持 `harness=pi`。模型凭据放在 Pi 配置目录内的 `auth.json`、`models.json` 或其引用的环境变量中，不通过 adaptor 的配置 API 传递密钥。IM 登录与模型认证互相独立；输入被明确拒绝时会显示具体原因。

每个配置完整且启用的 Agent 常驻一个 Pi 主会话及一个 RPC 进程。来自不同单聊、群聊的输入汇入该主会话，并保留消息、发送者、来源和引用信息。统一的“启用／停用 Agent”控制 Trigger 连接和 Pi 进程；“中止当前执行”只中止工作。网络重连和重新认证不会更换主会话；Pi 故障不影响收件，Trigger 断线不停止 Pi。浏览器关闭不影响后台运行。

修改已有运行配置需要先停用 Agent，保存后在下次启用时生效。会话绑定保持不变；不会因为更改工作目录、模型或凭据目录而清空历史。异常实例关闭后保留错误状态，由用户停用／重新启用重试，不自动循环重启。每个实例每 10 秒探测一次，单次 RPC 超时为原客户端的 30 秒；关闭先给 abort 最多 3 秒，再使用原客户端的 SIGTERM／SIGKILL 清理流程。

## 数据和鉴权

完整表结构在 [backend/sql/schema.sql](backend/sql/schema.sql)：

- `agents`：IM 身份、显示名与用户名缓存、短期 Bearer Token、到期时间、启用设置和时间戳。账号密码仅用于登录，不落盘；MVP 的 Token 保存在私有 SQLite 文件内，不返回给浏览器。
- `sessions`：每个 Agent 一个稳定主 session，保存 harness、工作目录、运行配置和 Pi 原生 ID／会话文件引用。Pi 历史保存在 `<data_root>/<session_id>/`，空会话先保存 ID，文件实际生成后再保存路径。
- `inbox`：本地递增 ID、接收 Agent、消息 ID、channel ID、完整消息 JSON、投递状态、接收回执、最近错误和接收时间。`(agent_id, message_id)` 唯一；按本地 ID 提交输入，不用不同 IM 会话各自的 `message_seq` 做全局排序。

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
| `GET/PATCH /agents/{id}/runtime` | 读取／保存 `{harness:"pi",cwd,config:{pi_config_dir,provider?,model?,extensions?}}`；修改已有配置前先停用 |
| `GET /agents/{id}/main-session` | 返回主会话引用、状态、模型名称、队列数量、错误和派发阻塞状态 |
| `POST /sessions/{id}/abort` | JSON `{}`；中止当前执行，保留进程与 Agent 启用状态 |
| `GET /sessions/{id}/events` | 可选 `after`、`epoch`；返回 `{epoch,events,truncated}`，以进程 epoch 识别后端重启 |
| `POST /sessions/{id}/inputs/{input_id}/resolve` | 停用后核对历史，再提交 `{action:"retry"或"accepted",confirmed:true}`；仅处理拒绝／待恢复记录 |

连接状态为 `disabled`、`connecting`、`online`、`reconnecting`、`auth_required` 或 `conflict`。会话状态独立展示：`unconfigured`、`starting`、`idle`、`busy`、`compacting`、`stopping`、`disabled` 或 `error`。停用不会删除收件记录、历史或云端账号。前端每两秒轮询；每个 session 缓存最近 300 条执行事件，不持久化，重启后清空。Pi 原生历史仍保留。

## 投递约定

Trigger `GET /agent-connections` 接受 Bearer 身份凭据。协议帧为：

```text
ready    {agent_id, token, expires_at}       Trigger → adaptor
delivery {agent_id, channel_id, message}     Trigger → adaptor
ack      {message_id}                       adaptor → Trigger
```

客户端先提交 SQLite 写入，再发送 ACK。重复消息只补发 ACK；写入失败会断开，等待 Trigger 重发。Trigger 对每个 Agent 的每个 channel 独立投递：从已入库消息中按 `message_seq` 取未确认队首，每个 channel 最多一条在途，收到 ACK 后再推进；不同 channel 共用 WS，各自等待 ACK 和重试。五秒未确认则重发，十五秒发一次 Ping，四十五秒无 Pong 断开。客户端断线后每两秒重连。ACK 只表示本机接收成功，不表示 Pi 已执行。

落盘与 ACK 完成后唤醒 Dispatcher；派发失败不影响 ACK。后台每 2 秒补扫。每个 session 只有一个派发流程，其他 session 可并行推进；每条输入只等待 RPC 接收回执，不等模型执行完成。压缩等明确暂时拒绝按 1、2、4、8、16、30 秒退避，后续输入不越过队首。

投递状态是 `pending`、`sending`、`accepted`、`rejected`、`needs_recovery`。回执 `started`／`queued`／`handled` 分别代表启动、排队或扩展处理，都不代表业务任务完成；空闲依据 `agent_settled` 与状态查询，不依据 `agent_end`。

关闭和恢复时，pi-adaptor 使用 Pi 的原生解析器核对持久化 user 输入是否与带本地输入 ID 的完整信封一致。找到确切记录可确认已接收；扩展改写了输入、队列未落盘、RPC 断开等无法核对的情况进入待恢复，暂停该 session。重启不会把 `sending` 直接回退为 `pending`，也不会自动重放未知结果。页面提供停用后核对与重试操作；重试可能再次执行原工具。已保存的历史文件缺失时必须恢复文件，不能静默新建空上下文。仅有 `handled` 回执且没有模型历史的空会话可按原 ID 重新打开。

## 验证

```sh
npm run test:adaptor
TRIGGER_TEST_MYSQL=1 go test -race ./server/backend/trigger/...
```

Node 测试使用真实临时 SQLite、原生 RpcClient 与协议子进程，验证并发、顺序、去重、启停、异常恢复、旧库结构拒绝启动且数据不变和 HTTP 接口；另通过真实 Pi RPC 和本地 OpenAI 兼容模拟模型执行文件工具，验证 steering、事件和重启历史。Go 集成测试使用仓库外的隔离 MySQL、真实 IM 服务、Trigger WS、Node adaptor 和真实 Pi RPC，从 IM 建会话、群聊 @、发消息到 Pi 输出验证完整链路，并保留原有鉴权、ACK、重连和恢复覆盖。模型服务仅为环回地址上的确定性测试服务，不验证外部模型服务或个人模型凭据。所有测试账号与消息仅存在于临时测试库。
