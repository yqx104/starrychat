# Trigger 服务

独立 Go 触发服务，接收 channel 消息，向订阅该 channel 的 Agent 投递。首版 channel 来源为 [IM](../im/README.md) 的单聊和群聊，后续可接入微信、飞书等来源。

单聊消息投递给发送者之外的 Agent 订阅者；群聊消息投递给被 @ 的 Agent 订阅者，没有 @ 时不投递。真人和 Agent 使用相同规则，Agent 可以 @ 其他 Agent，Trigger 不增加发送者类型、调用链层数或循环触发限制；这些协作约束由后续 skill 管理。

通过各 harness 的适配入口向目标 Agent 投递任务。内置 [Pi Agent](../../../agents/pi/README.md) 是默认接入对象，未来也可接入外部 Agent；Trigger 不导入 Pi 底层包，不承担模型和工具执行。这条唤起链路与 Agent 使用统一 IM CLI 读写消息相互独立，首版不引入 ACP。

## 代码分层与调用方式

与 IM 保持相同的包层级：

```text
cmd/          读取配置、组装依赖、启动 HTTP、处理退出信号
handler/      HTTP 路由与 JSON 请求/响应
service/      注册、订阅事务、接收者选择与投递编排
repository/   MySQL 连接池、SQL 与表结构就绪检查
delivery/     向 Agent 适配入口发送 HTTP 消息
common/       模块内可复用的 UUIDv7 生成与格式判断
model/        Agent、Channel、请求与消息事件等共享数据类型
config/       私有运行配置
sql/          当前完整表结构
tests/        本服务的测试
```

依赖方向为 `handler → service → repository`，共享类型放在 `model`，通用方法放在 `common`。Trigger 保持独立 Go 模块，不导入 IM 的业务包。

当前上游只有同机部署的 IM，使用本机 HTTP/JSON 同步调用，默认监听 `127.0.0.1:4182`。将 IM 视为可信调用方，不增加 JWT、签名、调用方权限中间件，也不重复查询 IM 的用户归属、会话成员关系。IM 负责这些检查；Trigger 负责自己的注册和订阅状态、唯一性、事务与数据库错误处理。

## HTTP 接口

已实现 `GET /healthz`：经 handler、service、repository 检查数据库连接，成功返回 `200 {"status":"ok"}`，数据库不可用返回 `503`。启动时另外检查两张表的所需字段；缺表时启动失败，不自动改表。

以下五个业务接口均已实现，调用不需要认证头：

| 接口 | 参数 | IM 调用时机与职责 |
| --- | --- | --- |
| `PUT /agents/{agent_id}` | 路径中的 IM Agent UUIDv7；无需请求体 | 返回 `200 {agent}`。重复调用返回已有记录，保留首次注册时间。 |
| `POST /channels/subscriptions` | `channel_type`、`conversation_id`、非空 `agent_ids` | 返回 `200 {channel_id, channels}`；`channels` 仅包含本次请求的 Agent，按输入顺序去重。 |
| `DELETE /channels/{channel_type}/{conversation_id}/agents/{agent_id}` | 路径参数 | 取消单个订阅，返回 `204`。记录不存在也视为成功。 |
| `DELETE /channels/{channel_type}/{conversation_id}` | 路径参数 | 清理会话全部订阅，返回 `204`。记录不存在也视为成功。 |
| `POST /messages` | 来源会话与消息事件，见下文 | 查询订阅并同步投递，返回每个目标的成功或失败结果。 |

IM 始终使用已有的 `channel_type + conversation_id` 调用，不需要持久化 Trigger 的 `channel_id`。当前 HTTP 接口接受 `im_direct`、`im_group` 和 IM 的 UUIDv7 会话 ID。订阅前 Agent 必须已注册；批量订阅在一个事务内完成，任一 Agent 未注册返回 `404 NOT_FOUND` 并回滚整批。首次并发订阅共享同一个 channel ID，同一 Agent 重复订阅保留已有记录。没有 Agent 的会话无需调用订阅接口。

消息事件接收 `channel_type`、`conversation_id`、`message_id`、`message_seq`、`sender_id`、`sender_kind`、`content`、`mentioned_agent_ids`、`quoted_message_id` 和 `created_at`。业务 ID 沿用 IM 的 UUIDv7 字符串；`message_seq` 是 IM 会话内递增序号，不能跨会话比较。IM 提供完整消息，Trigger 保留这些字段，不回查 IM，也不另分配消息 ID 或序号。

消息响应含 `channel_id`（存在订阅时）、`delivered_agent_ids` 和 `failed_agent_ids`。群聊中的重复 @ 只投递一次，未订阅的 @ 对象不投递。没有接收者时返回 `200` 和两个空列表。投递按查询时的订阅快照执行，取消订阅不撤销已经开始的投递。

基础参数错误返回 `400 INVALID_REQUEST`。数据库错误返回 `500 INTERNAL_ERROR`。投递未配置或失败的响应见下节。

Agent 改名或修改登录信息不需要通知 Trigger，因为当前注册表只存身份。IM 尚无删除 Agent 账号的入口，暂不增加注销接口。Agent 列表和会话查询仍由 IM 提供；Trigger 的查询管理接口按实际使用需要补充。

## Agent 投递

通过私有配置的可选字段 `agent_delivery_url` 指定一个完整 HTTP 接收地址。Trigger 向该地址 POST `{agent_id, channel_id, message}`；同一个适配入口按 `agent_id` 找到对应 Agent，`message` 是上游传入的完整事件。这是 Trigger 的投递协议，Pi 的实际运行适配入口仍待实现。

每个接收者并行请求一次，单次 HTTP 超时为 10 秒，不自动重试。适配入口返回 `2xx` 表示已接收消息，对应 ID 进入 `delivered_agent_ids`；这不表示模型已完成执行。重定向、非 `2xx` 响应和连接错误均计为失败。

全部目标投递成功返回 `200`。任何目标失败返回 `502 DELIVERY_FAILED`，同时保留已经成功和失败的 Agent ID 列表。有目标但未配置 `agent_delivery_url` 时返回 `503 DELIVERY_UNAVAILABLE`，目标全部列入失败列表，不伪装成已投递。

Trigger 当前不存消息队列或去重记录。重复提交同一个 `message_id` 会再次投递，接收端以 `(agent_id, message_id)` 去重；跨请求的会话处理顺序也由接收端结合 `message_seq` 管理。

## 数据库

使用独立的 MySQL 数据库 `trigger`，当前完整表结构见 [sql/schema.sql](sql/schema.sql)。与 IM 采用相同的 InnoDB、`utf8mb4_0900_bin` 和 Unix 毫秒时间戳约定。

| 表 | 字段 | 含义 |
| --- | --- | --- |
| `agents` | `agent_id`、`created_at` | 已注册的 Agent；`agent_id` 沿用 IM 中 `kind=agent` 的 `participant_id`，不重新分配，时间为 Trigger 注册时间。 |
| `channels` | `agent_id`、`channel_id`、`channel_type`、`conversation_id`、`created_at` | Agent 对 channel 的订阅；时间为订阅创建时间。 |

Agent 表先只登记身份。显示名、所属真人、登录账号和密码由 IM 管理；运行器配置在确定投递协议后补充。

两张表的 `agent_id` 均使用 `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`，沿用 IM 的标准小写 UUIDv7，并由数据库校验格式。

`channel_id` 由 Trigger 订阅接口生成小写 UUID v7，数据库校验其格式与版本。`conversation_id` 是来源系统的会话标识。IM 的会话 UUIDv7 直接保存为标准字符串；数据库字段也为后续外部平台保留了字符串 ID 的空间。

`channel_type` 首版约定 `im_direct` 和 `im_group`，使用字符串而不是数据库枚举。`(channel_type, conversation_id)` 标识来源会话；未来一个来源接入多个账号或租户时，需要在接入设计中明确账号命名空间，避免外部会话 ID 冲突。

同一来源会话中的多个 Agent 共享一个 `channel_id`，各自占一条订阅记录。因此 `channel_id` 不单独唯一，`(agent_id, channel_id)` 是联合主键。另有唯一索引 `(channel_type, conversation_id, agent_id)`，防止注册订阅重试时换一个 UUID 写出重复订阅；该索引也支持按来源会话查出订阅者。`(channel_id, agent_id)` 索引支持按 Trigger channel ID 查找订阅者。

当前按单个 Trigger 实例部署，service 使用同一把锁串行化订阅与退订，事务内查询或生成共享 UUID。上述唯一索引只约束单个 Agent 的重复订阅，不能替代实例之间的协调；当前实现不支持多个 Trigger 进程同时写入同一库。最后一条订阅删除后不再保留该映射，重新订阅时生成新的 channel ID。订阅前由 Trigger 确认 Agent 已注册；来源会话、归属及成员身份由可信上游 IM 校验，不建立跨库外键。

## 后续接口对接

IM 是创建 Agent 的入口。后续对接顺序为：创建 Agent 后向 Trigger 注册；创建单聊、创建群聊或往群里添加 Agent 时创建订阅；移除 Agent 和解散群聊时调用对应删除接口；消息落库后调用 `POST /messages`。跨服务失败处理在接入 IM 调用链时完成。

当前已实现五个业务接口、消息接收者选择和可配置的 HTTP 投递出口。IM 尚未调用这些接口，Pi/Agent 实际接收入口尚未实现，未回填已有 IM 数据。本机 `agent_delivery_url` 尚未配置；完整投递链路通过隔离 MySQL 和测试 HTTP 接收端验证。

## 本机启动与维护

MySQL 由 Homebrew 独立运行。由管理员创建 `trigger` 空库并执行 `sql/schema.sql`，为专用应用账号 `trigger_app` 授予该库的 `SELECT, INSERT, UPDATE, DELETE` 权限。该文件只保存当前表结构，不包含建库、建账号或迁移逻辑。

私有配置位于 `localdeploy/trigger/config.json`，包含 `mysql_dsn`、`address` 和可选的 `agent_delivery_url`；监听地址默认 `127.0.0.1:4182`，与 IM 的 `4180` 和隔离联调实例的 `4181` 分开。配置权限为 `0600`，运行目录为 `0700`，凭据只保存在该配置文件中。

```sh
./localdeploy/trigger/start.sh
./localdeploy/trigger/status.sh
curl http://127.0.0.1:4182/healthz
./localdeploy/trigger/stop.sh
```

也可运行 `go run ./server/backend/trigger/cmd -config localdeploy/trigger/config.json`，或通过 `TRIGGER_CONFIG` 指定配置路径。SIGINT/SIGTERM 会先停止 HTTP、等待请求结束，再关闭数据库连接池。

本机启动脚本构建 `localdeploy/trigger/trigger-server`，PID 保存在 `localdeploy/trigger/trigger.pid`，日志只写入 `locallog/trigger/trigger.log`。统一 `localdeploy/start.sh` 按 Trigger → IM → IM Web 启动，停止时顺序相反。`localdeploy/` 和 `locallog/` 被 Git 忽略，不随仓库分发；启停脚本不执行 SQL。

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

默认测试覆盖健康检查、缺少配置时启动失败，以及投递取消和重定向失败。`TRIGGER_TEST_MYSQL=1` 在仓库外创建一次性私有 MySQL 实例，关闭网络监听，通过真实 HTTP 和测试 Agent 接收端验证五个接口、批量回滚、并发 UUID 复用、退订、Agent 相互 @、消息字段传递、部分投递失败、未配置出口和连接池重开后的持久化；结束后关闭并清理该实例。

`TRIGGER_TEST_CONFIG` 仅对指定配置执行 MySQL 只读检查：打开独立连接池、检查现有表、验证 HTTP 到数据库的链路，并确认关闭该连接池后健康检查返回 `503`。不会向本机业务库写入测试数据或修改表结构。
