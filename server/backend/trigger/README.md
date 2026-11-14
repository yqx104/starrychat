# Trigger 服务

独立 Go 触发服务，接收 channel 消息，向订阅该 channel 的 Agent 投递。首版 channel 来源为 [IM](../im/README.md) 的单聊和群聊，后续可接入微信、飞书等来源。

单聊消息投递给发送者之外的 Agent 订阅者；群聊消息投递给被 @ 的 Agent 订阅者，没有 @ 时不投递。真人和 Agent 使用相同规则，Agent 可以 @ 其他 Agent，Trigger 不增加发送者类型、调用链层数或循环触发限制；这些协作约束由后续 skill 管理。

通过各 harness 的适配入口向目标 Agent 投递任务。内置 [Pi Agent](../../../agents/pi/README.md) 是默认接入对象，未来也可接入外部 Agent；Trigger 不导入 Pi 底层包，不承担模型和工具执行。这条唤起链路与 Agent 使用统一 IM CLI 读写消息相互独立，首版不引入 ACP。

## 代码分层与调用方式

与 IM 保持相同的包层级：

```text
cmd/          读取配置、组装依赖、启动 HTTP、处理退出信号
handler/      HTTP 路由与 JSON 请求/响应
service/      注册、订阅事务、接收者选择与消息入队
repository/   MySQL 连接池、SQL 与表结构就绪检查
connections/  Agent WebSocket 鉴权、连接、投递与 ACK
imclient/     调用 IM 身份接口、解析身份与续签凭据
common/       模块内可复用的 UUIDv7 生成与格式判断
model/        Agent、Channel、请求与消息事件等共享数据类型
config/       私有运行配置
sql/          当前完整表结构
tests/        本服务的测试
```

普通 HTTP 接口依赖方向为 `handler → service → repository`；WS 握手由 `connections → imclient` 调用 IM 的 `GET /auth/me`，投递由 `connections → repository` 读取待投递记录并处理 ACK。`cmd` 创建并注入 `imclient`，HTTP 请求超时为五秒，不跟随重定向。共享类型放在 `model`，通用方法放在 `common`。Trigger 保持独立 Go 模块，生产代码不导入 IM 的业务包；跨服务集成测试通过仓库的 `go.work` 组装真实服务。

当前上游只有同机部署的 IM，使用本机 HTTP/JSON 同步调用，默认监听 `127.0.0.1:4182`。将 IM 视为可信调用方，不增加 JWT、签名、调用方权限中间件，也不重复查询 IM 的用户归属、会话成员关系。IM 负责这些检查；Trigger 负责自己的注册和订阅状态、唯一性、事务与数据库错误处理。

## HTTP 接口

已实现 `GET /healthz`：经 handler、service、repository 检查数据库连接，成功返回 `200 {"status":"ok"}`，数据库不可用返回 `503`。启动时检查三张表的所需字段；缺表时启动失败，不自动改表。

以下五个业务接口均已实现，调用不需要认证头：

| 接口 | 参数 | IM 调用时机与职责 |
| --- | --- | --- |
| `PUT /agents/{agent_id}` | 路径中的 IM Agent UUIDv7；无需请求体 | 返回 `200 {agent}`。重复调用返回已有记录，保留首次注册时间。 |
| `POST /channels/subscriptions` | `channel_type`、`conversation_id`、非空 `agent_ids` | 返回 `200 {channel_id, channels}`；`channels` 仅包含本次请求的 Agent，按输入顺序去重。 |
| `DELETE /channels/{channel_type}/{conversation_id}/agents/{agent_id}` | 路径参数 | 取消单个订阅，返回 `204`。记录不存在也视为成功。 |
| `DELETE /channels/{channel_type}/{conversation_id}` | 路径参数 | 清理会话全部订阅，返回 `204`。记录不存在也视为成功。 |
| `POST /messages` | 来源会话与消息事件，见下文 | 持久化目标投递记录并返回 `202`，由 WS 后续投递；无接收者返回 `200`。 |

IM 始终使用已有的 `channel_type + conversation_id` 调用，不需要持久化 Trigger 的 `channel_id`。当前 HTTP 接口接受 `im_direct`、`im_group` 和 IM 的 UUIDv7 会话 ID。订阅前 Agent 必须已注册；批量订阅在一个事务内完成，任一 Agent 未注册返回 `404 NOT_FOUND` 并回滚整批。首次并发订阅共享同一个 channel ID，同一 Agent 重复订阅保留已有记录。没有 Agent 的会话无需调用订阅接口。

消息事件接收 `channel_type`、`conversation_id`、`message_id`、`message_seq`、`sender_id`、`sender_kind`、`content`、`mentioned_agent_ids`、`quoted_message_id` 和 `created_at`。业务 ID 沿用 IM 的 UUIDv7 字符串；`message_seq` 是 IM 会话内递增序号，不能跨会话比较。IM 提供完整消息，Trigger 保留这些字段，不回查 IM，也不另分配消息 ID 或序号。

消息响应含 `channel_id`（存在订阅时）和 `queued_agent_ids`。群聊中的重复 @ 只生成一条投递记录，未订阅的 @ 对象不投递。没有接收者时返回 `200` 和空的 `queued_agent_ids` 列表。入队按查询时的订阅快照执行，取消订阅不撤销已经入队的投递。

基础参数错误返回 `400 INVALID_REQUEST`。数据库错误返回 `500 INTERNAL_ERROR`，入队事务失败时回滚所有目标记录。

Agent 改名或修改登录信息不需要通知 Trigger，因为当前注册表只存身份。IM 尚无删除 Agent 账号的入口，暂不增加注销接口。Agent 列表和会话查询仍由 IM 提供；Trigger 的查询管理接口按实际使用需要补充。

## Agent 投递

Trigger 通过 WebSocket 向 adaptor 投递，消息先保存到 MySQL。配置中的 `im_base_url` 用于握手鉴权。`GET /agent-connections` 在握手时将 Bearer 凭据交给 IM `/auth/me` 验证，只接受 Agent 身份；验证成功后幂等登记 Agent。单个 Trigger 实例对每个 Agent 仅允许一个活动连接，重复连接返回 `409`。每次连接返回 IM 续签的 Token 和到期时间，凭据到期关闭连接。

`POST /messages` 在一个事务中为所有目标写入 `deliveries`，返回 `202` 和 `queued_agent_ids`；只确认消息已受理，不等待 Agent 在线或 ACK。无目标返回 `200`。`(agent_id,message_id)` 唯一，已确认记录保留以去重。`channel_id` 和 `message_seq` 独立存列，用于按 `(agent_id,channel_id)` 查询待投递队列。

每个 Agent 连接用 map 保存各 channel 的在途消息和发送时间。每个 channel 从已入库的未确认消息中选择最小 `message_seq`，一次发送一条；收到当前消息的 ACK 并写入 `acked_at` 后，再取该 channel 的下一条。序号允许有缺口，不等待连续值。不同 channel 独立等待 ACK 和重试，共用该 Agent 的 WS；一个 channel 等待确认不会阻塞其他 channel。ACK 仍只带 `message_id`，非当前在途消息的 ACK 不推进队列。

连接建立时从数据库发现未确认的 channel，并读取各自队首；连接期间每秒检查新消息。连接断开或 Trigger 重启不会删除未确认记录，重连后重新读取数据库恢复，无需把全部消息加载到内存。各 channel 五秒未收到 ACK 则重发；每十五秒 Ping，四十五秒无 Pong 断开。客户端需要在 SQLite 写入提交后 ACK，重复投递只补发 ACK。接收端与本机启动方式见 [客户端说明](../../../client/adaptor/README.md)。这条链路只确认接收，尚不运行 Pi。

## 数据库

使用独立的 MySQL 数据库 `trigger`，当前完整表结构见 [sql/schema.sql](sql/schema.sql)。与 IM 采用相同的 InnoDB、`utf8mb4_0900_bin` 和 Unix 毫秒时间戳约定。

| 表 | 字段 | 含义 |
| --- | --- | --- |
| `agents` | `agent_id`、`created_at` | 已注册的 Agent；`agent_id` 沿用 IM 中 `kind=agent` 的 `participant_id`，不重新分配，时间为 Trigger 注册时间。 |
| `channels` | `agent_id`、`channel_id`、`channel_type`、`conversation_id`、`created_at` | Agent 对 channel 的订阅；时间为订阅创建时间。 |
| `deliveries` | `id`、`agent_id`、`channel_id`、`message_id`、`message_seq`、`payload`、`created_at`、`acked_at` | 每个目标的持久化投递记录，唯一键为 `(agent_id,message_id)`；待投递索引为 `(agent_id,channel_id,acked_at,message_seq)`。 |

Agent 表先只登记身份。显示名、所属真人、登录账号和密码由 IM 管理；运行器配置在确定投递协议后补充。

三张表的 `agent_id` 均使用 `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`，沿用 IM 的标准小写 UUIDv7；注册和订阅表由数据库校验格式。

`channel_id` 由 Trigger 订阅接口生成小写 UUID v7，数据库校验其格式与版本。`conversation_id` 是来源系统的会话标识。IM 的会话 UUIDv7 直接保存为标准字符串；数据库字段也为后续外部平台保留了字符串 ID 的空间。

`channel_type` 首版约定 `im_direct` 和 `im_group`，使用字符串而不是数据库枚举。`(channel_type, conversation_id)` 标识来源会话；未来一个来源接入多个账号或租户时，需要在接入设计中明确账号命名空间，避免外部会话 ID 冲突。

同一来源会话中的多个 Agent 共享一个 `channel_id`，各自占一条订阅记录。因此 `channel_id` 不单独唯一，`(agent_id, channel_id)` 是联合主键。另有唯一索引 `(channel_type, conversation_id, agent_id)`，防止注册订阅重试时换一个 UUID 写出重复订阅；该索引也支持按来源会话查出订阅者。`(channel_id, agent_id)` 索引支持按 Trigger channel ID 查找订阅者。

当前按单个 Trigger 实例部署，service 使用同一把锁串行化订阅与退订，事务内查询或生成共享 UUID。上述唯一索引只约束单个 Agent 的重复订阅，不能替代实例之间的协调；当前实现不支持多个 Trigger 进程同时写入同一库。最后一条订阅删除后不再保留该映射，重新订阅时生成新的 channel ID。订阅前由 Trigger 确认 Agent 已注册；来源会话、归属及成员身份由可信上游 IM 校验，不建立跨库外键。

## IM 接口对接

IM 的 `POST /agents` 是创建 Agent 账号的唯一入口。创建时在本地事务里写入账号、与 owner 的单聊，以及 `register_agent` 和单聊订阅待同步事件，提交后由后台调用 `PUT /agents/{agent_id}` 登记并同步订阅；Trigger 不可用时保留事件重试，IM 账号创建仍可成功。创建群聊或往群里添加 Agent 时也创建订阅；移除 Agent 和解散群聊时调用对应删除接口；发送消息时调用 `POST /messages`。这些操作都通过 IM 的 `triggerclient` 接入。

会话变更与消息先在 IM 事务中写入持久化待同步队列，提交后按会话顺序调用 Trigger；失败自动重试，IM 重启后继续。会话创建时记录订阅，成员变更时记录增量事件；订阅同步前幂等登记 Agent。客户端 WS 握手仍会幂等登记 Agent。IM 的业务 HTTP 成功、Trigger 接收入队和 Adaptor 落盘 ACK 是不同阶段；Pi 执行入口尚未实现。

## 本机启动与维护

MySQL 由 Homebrew 独立运行。由管理员创建 `trigger` 空库并执行 `sql/schema.sql`，为专用应用账号 `trigger_app` 授予该库的 `SELECT, INSERT, UPDATE, DELETE` 权限。该文件只保存当前表结构，不包含建库、建账号或迁移逻辑。

私有配置位于 `localdeploy/trigger/config.json`，`mysql_dsn` 和 `im_base_url` 为必填项；可选的 `address` 默认监听 `127.0.0.1:4182`。缺少 IM 地址时启动失败。配置权限为 `0600`，运行目录为 `0700`，凭据只保存在该配置文件中。

```sh
./localdeploy/trigger/start.sh
./localdeploy/trigger/status.sh
curl http://127.0.0.1:4182/healthz
./localdeploy/trigger/stop.sh
```

也可运行 `go run ./server/backend/trigger/cmd -config localdeploy/trigger/config.json`，或通过 `TRIGGER_CONFIG` 指定配置路径。SIGINT/SIGTERM 会先停止 HTTP、等待请求结束，再关闭数据库连接池。

本机启动脚本构建 `localdeploy/trigger/trigger-server`，PID 保存在 `localdeploy/trigger/trigger.pid`，日志只写入 `locallog/trigger/trigger.log`。统一入口按 Trigger → IM → IM Web → adaptor → adaptor Web 启动，停止时顺序相反。`localdeploy/` 和 `locallog/` 被 Git 忽略，不随仓库分发；启停脚本不执行 SQL。

修改已有库时，先停止访问该库的应用，备份需要保留的数据到仓库外私有目录，再直接执行必要 SQL，并同步更新本服务的 `sql/schema.sql`。重新构建、启动受影响的服务，验证后删除本次备份。不在启动脚本中执行 SQL，也不维护迁移脚本、迁移版本或自动改表逻辑。

## 验证

在仓库根目录运行：

```sh
go build ./server/backend/trigger/...
go vet ./server/backend/trigger/...
go test -race ./server/backend/trigger/...
TRIGGER_TEST_MYSQL=1 go test -race ./server/backend/trigger/...
TRIGGER_TEST_CONFIG="$PWD/localdeploy/trigger/config.json" go test -race ./server/backend/trigger/...
```

默认测试覆盖健康检查、缺少配置或 `im_base_url` 时启动失败，以及 IM 客户端的 Bearer 传递、续签凭据解析、握手鉴权失败状态码、禁止重定向和请求截止时间。`TRIGGER_TEST_MYSQL=1` 在仓库外创建一次性私有 MySQL 实例，关闭网络监听，通过真实 HTTP 和数据库验证五个接口、批量回滚、并发 UUID 复用、退订、Agent 相互 @、消息字段保存、入队去重、离线入队、写入失败整批回滚和连接池重开后的持久化；结束后关闭并清理该实例。

同一测试开关还运行 `TestAdaptorEndToEnd`：启动真实 IM 和 Node adaptor，通过 IM 接口创建单聊/群聊、添加/移除成员、解散群聊和发送消息，验证订阅同步、群聊 @ 选择、WS 鉴权、重复连接拒绝、SQLite 落盘 ACK、重复投递、三端重启、Trigger 不可用时 IM 仍持久化消息并在重启后补发，以及凭据到期关闭。运行前在仓库根安装 npm 依赖；测试不访问业务库，不发出模型请求。

`TestIMTriggerSyncEndToEnd` 在测试进程内组装真实 IM、Trigger、HTTP、MySQL 和 WS，验证 Trigger 不可用时创建 Agent、登记重试及响应丢失后的幂等处理、完整业务接口、停机补发、同步循环重启、远端入队后响应丢失的重试去重、真人和 Agent 消息载荷、退订及解散顺序。该测试不依赖 Node，也不启动额外的服务二进制。

`TestChannelDeliveryOrderACKAndRecovery` 使用隔离 MySQL 和真实 WS，验证 channel 内按序号取队首、序号缺口、跨 channel 独立 ACK、新 channel 发现、超时重发、忽略非在途 ACK，以及重启恢复和 Agent 间隔离。

`TRIGGER_TEST_CONFIG` 仅对指定配置执行 MySQL 只读检查：打开独立连接池、检查现有表、验证 HTTP 到数据库的链路，并确认关闭该连接池后健康检查返回 `503`。不会向本机业务库写入测试数据或修改表结构。
