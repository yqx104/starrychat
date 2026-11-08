# Trigger 服务

独立 Go 触发服务，接收 channel 消息，向订阅该 channel 的 Agent 投递。首版 channel 来源为 [IM](../im/README.md) 的单聊和群聊，后续可接入微信、飞书等来源。

首版规则：用户在单聊发送消息直接触发对方；用户在群聊发送消息只触发被 @ 的一个或多个 Agent。群聊没有 @ 时不自动触发，全量感知延期。

是否允许 Agent 发出的 @ 触发其他 Agent，尚未确定。

通过各 harness 的适配入口向目标 Agent 投递任务。内置 [Pi Agent](../../agents/pi/README.md) 是默认接入对象，未来也可接入外部 Agent；Trigger 不导入 Pi 底层包，不承担模型和工具执行。这条唤起链路与 Agent 使用统一 IM CLI 读写消息相互独立，首版不引入 ACP。

## 数据库

使用独立的 MySQL 数据库 `trigger`，当前完整表结构见 [sql/schema.sql](sql/schema.sql)。与 IM 采用相同的 InnoDB、`utf8mb4_0900_bin` 和 Unix 毫秒时间戳约定。

| 表 | 字段 | 含义 |
| --- | --- | --- |
| `agents` | `agent_id`、`created_at` | 已注册的 Agent；`agent_id` 沿用 IM 中 `kind=agent` 的 `participant_id`，不重新分配，时间为 Trigger 注册时间。 |
| `channels` | `agent_id`、`channel_id`、`channel_type`、`conversation_id`、`created_at` | Agent 对 channel 的订阅；时间为订阅创建时间。 |

Agent 表先只登记身份。显示名、所属真人、登录账号和密码由 IM 管理；运行器配置在确定投递协议后补充。

两张表的 `agent_id` 均使用 `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`，沿用 IM 的标准小写 UUIDv7，并由数据库校验格式。

`channel_id` 约定由后续 Trigger 订阅接口生成小写 UUID v7，数据库校验其格式与版本。`conversation_id` 是来源系统的会话标识。IM 的会话 UUIDv7 直接保存为标准字符串；外部平台可直接保存字符串 ID。字段统一拼写为 `conversation_id`。

`channel_type` 首版约定 `im_direct` 和 `im_group`，使用字符串而不是数据库枚举。`(channel_type, conversation_id)` 标识来源会话；未来一个来源接入多个账号或租户时，需要在接入设计中明确账号命名空间，避免外部会话 ID 冲突。

同一来源会话中的多个 Agent 共享一个 `channel_id`，各自占一条订阅记录。因此 `channel_id` 不单独唯一，`(agent_id, channel_id)` 是联合主键。另有唯一索引 `(channel_type, conversation_id, agent_id)`，防止注册订阅重试时换一个 UUID 写出重复订阅；该索引也支持按来源会话查出订阅者。`(channel_id, agent_id)` 索引支持按 Trigger channel ID 查找订阅者。

保持两张表时，来源会话到 `channel_id` 的一致映射需要由后续订阅服务在并发控制下维护；上述唯一索引只能阻止单个 Agent 的重复订阅，不能保证不同 Agent 一定使用同一 UUID。与 IM 一样，关联校验由服务完成，不建立跨库外键；订阅前必须确认 Agent 已注册，IM 对接时还需校验来源会话及成员身份。

## 后续接口对接

IM 是创建 Agent 的入口。后续对接顺序为：创建 Agent 后向 Trigger 注册；创建单聊、创建群聊或往群里添加 Agent 时创建订阅；重复打开单聊或重复请求应返回已有订阅。移除 Agent 和解散群聊时，需要同步移除相应订阅，防止继续投递。跨服务失败重试与补偿在接口实现时一并处理。

本次仅落表，未回填已有 IM 数据。当前 Go 模块已纳入根目录 `go.work`，但尚无运行入口、Agent 注册接口、订阅接口、IM 调用链、消息投递或运行器。事件传输、唤起协议、排队和消息去重留待后续设计；后续测试放在本服务自己的 `tests/` 目录。

## 本机维护

MySQL 由 Homebrew 独立运行。由管理员创建 `trigger` 空库并执行 `sql/schema.sql`；该文件只保存当前表结构，不包含建库、建账号或迁移逻辑。Trigger 尚无运行服务或应用数据库账号，接入服务时再配置专用账号。

修改已有库时，先停止访问该库的应用，备份需要保留的数据到仓库外私有目录，再直接执行必要 SQL，并同步更新本服务的 `sql/schema.sql`。重新构建、启动受影响的服务，验证后删除本次备份。不在启动脚本中执行 SQL，也不维护迁移脚本、迁移版本或自动改表逻辑。
