# IM 服务

独立 Go/MySQL 聊天服务。`handler/` 接收 HTTP，`service/` 检查业务规则并组织事务，`repository/` 执行 SQL；`common/` 提供 UUIDv7 生成和校验，`common/auth/` 处理 JWT 和账号格式校验，`config/` 读取私有运行配置，`model/` 保存共享类型。所有测试位于 `tests/`。参与者、会话、消息由后端统一生成小写标准 UUIDv7，数据库使用 `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`，接口统一传字符串。支持多个真人，每个 Agent 固定属于创建它的真人；原有成员、引用、@、解散规则与所属范围一起校验。关联校验和响应组装由 Service 完成，Repository 只查询单表。

IM 不执行触发规则、不唤起 Agent、不运行模型，也不依赖 Pi。Trigger 已实现注册、订阅和消息接口，IM 到 Trigger 的调用、事件传输和统一 IM CLI 尚未实现。[前端](../../frontend/im-web/README.md) 通过同源 `/im-api` 代理访问后端，代理必须保留浏览器的 Host 和 Origin。

## 标识与消息顺序

所有业务 ID、Agent 归属、消息引用和 `mentioned_agent_ids` 数组元素均为标准 UUIDv7 字符串。接口拒绝数字 ID、非 v7 UUID、非标准格式或大写 UUID；数据库也约束 ID 格式。JWT 的 `sub` 使用参与者 UUID，旧数字身份令牌不再有效。

消息新增数字字段 `message_seq`，每个会话从 1 开始独立递增。`conversations.last_message_seq` 初始为 0；发送在读已提交事务中通过 `SELECT ... FOR UPDATE` 锁定会话行，校验后递增计数器并插入消息，二者一起提交或回滚。`UNIQUE (conversation_id, message_seq)` 防止重复序号。序号最大为 `9007199254740991`，保持 JSON/JavaScript 数字精度；计数器不因重启或删除消息而重置。

`GET /conversations/:conversation_id/messages` 使用 `limit`（1–50，默认 50）、`before_seq`（正整数）或 `after_seq`（非负整数，0 表示从头读取），两个方向互斥。初始查询返回最新一页，before 返回紧邻的更早一页，after 返回紧邻的更新一页；响应始终按 `message_seq` 升序，`has_more` 表示该方向还有数据。旧 `before_message_id` / `after_message_id` 参数不再接受。序号仅在指定会话内比较，UUID 用于引用和去重，不用于消息排序。只读业务事务继续使用可重复读。

## 本机启动

MySQL 独立部署和管理；IM 只通过配置连接数据库。本机使用 Homebrew MySQL，监听 `127.0.0.1:3306`，数据位于仓库外的 `/opt/homebrew/var/mysql/`。需要时单独运行 `brew services start mysql`；停止 IM 不会停止 MySQL。

首次准备环境时，在 MySQL 中创建 `im` 空库、执行 `sql/schema.sql`，并为应用账号授予该库的 `SELECT, INSERT, UPDATE, DELETE` 权限。将连接信息写入私有的 `localdeploy/im/config.json`；这些准备操作由数据库管理员执行，应用启动脚本不会建库、建表、创建账号或修改结构。

配置就绪后，在仓库根目录运行，要求已有 Go、Python 3、Node.js，并已安装前端 npm 依赖：

```sh
./localdeploy/start.sh
./localdeploy/im/status.sh
./localdeploy/im-web/status.sh
./localdeploy/stop.sh
```

真实预览监听 `127.0.0.1:4180`，具体地址读取 `config.json`。脚本只构建和启停 IM、报告应用进程状态，不启动或关闭 MySQL，也不写入测试账号、群聊或消息。MySQL 不可用或配置缺失时，应用启动失败，不会自动创建数据库实例。

统一入口按 Trigger → IM → IM Web 启动，停止时顺序相反。Trigger 的配置与准备方式见 [Trigger 说明](../trigger/README.md)。前端使用 Vite 开发服务器，监听 `127.0.0.1:5173`，从 IM 配置中读取监听地址来设置 `/im-api` 代理。各服务也可通过各自目录中的 `start.sh`、`stop.sh`、`status.sh` 单独管理。MySQL 始终独立运行。

`localdeploy/` 和 `locallog/` 都已被 Git 忽略，包含本机脚本和运行文件，不随仓库分发：

```text
localdeploy/
├── start.sh
├── stop.sh
├── im/
│   ├── start.sh
│   ├── stop.sh
│   ├── status.sh
│   ├── local.py
│   ├── config.json
│   ├── im-server
│   ├── im.pid
│   └── signing.key
└── im-web/
    ├── start.sh
    ├── stop.sh
    ├── status.sh
    ├── local.py
    └── im-web.pid
locallog/
├── im/im.log
└── im-web/im-web.log
```

运行目录权限为 `0700`，配置、签名密钥为 `0600`。`config.json` 保存数据库连接配置，`signing.key` 保存随机生成的 32 字节 JWT 密钥；后续启动复用同一文件。日志只写入 `locallog/im/im.log`，正常停服会移除 `im.pid`。不要把凭据文件放入前端、源码或日志。密码以明文存入 `participant_accounts.password`，登录直接比较提交的密码，没有会话表、刷新表或撤销表。

直接启动 Go 入口：

```sh
go run ./backend/im/cmd -config localdeploy/im/config.json
```

也可用 `IM_CONFIG` 指定配置文件。配置字段是 `mysql_dsn`、`address`、`signing_key_file`、`insecure_local_http`、`issuer`、`audience`。默认地址 `127.0.0.1:4180`，相对密钥路径基于配置文件所在目录。HTTP 开发模式只允许环回 IP 监听；非本地 Cookie 请求须通过 HTTPS。入口检查连接及五张表后才开始监听，收到 SIGINT/SIGTERM 时先停止 HTTP 请求，再关闭连接池；缺少配置或表结构不符会明确失败，不隐式设置调用者。

需要前端隔离联调时，先独立准备测试库及其应用账号，再创建 `localdeploy/im/browser/config.json`，设置监听地址 `127.0.0.1:4181`、独立的 JWT 密钥和 issuer。日志写入 `locallog/im/browser/im.log`；以下命令只管理这份配置对应的 IM 进程，不创建或清理测试数据库：

```sh
./localdeploy/im/start.sh --browser
./localdeploy/im/status.sh --browser
./localdeploy/im/stop.sh --browser
```

浏览器 Cookie 不按端口隔离。切换两个实例前应退出并清理 Cookie；两个实例不互认 JWT。

## 认证契约

| 接口 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /auth/register` | `username,password,name,kind` | `201 {participant}` |
| `POST /auth/login` | `username,password,transport`，transport 为 `cookie` 或 `bearer` | `200 {participant,expires_at}`；仅 bearer 模式额外返回 `token` |
| `GET /auth/me` | 已认证 | `200 {participant}`，正常续期 |
| `POST /auth/logout` | 无业务请求体或 `{}` | `204`，清 Cookie，不续期 |

用户名区分大小写，3–64 个 ASCII 字母、数字、点、下划线或连字符，首位必须是字母或数字；密码为 8–72 字节；显示名为 1–100 个字符、不能全为空白。JSON 请求体统一最多 1 MiB。本机部署不设置登录、注册的频率和并发限制。

不同用户名可以分别注册 human，真人账号的 owner_participant_id 为 NULL。创建 Agent 账号要求当前身份是真人，owner_participant_id 从认证身份取得，不接受客户端指定。参与者和账号在同一事务中创建，失败不会留下半条注册记录。注册不会登录新身份；真人创建 Agent 时只续期真人自己的令牌。

Cookie 为 `im_token`，`HttpOnly; SameSite=Strict; Path=/`，HTTPS 下启用 Secure；仅明确开启的本机 HTTP 开发允许非 Secure。Cookie 的变更请求须同源；后端比较实际 Origin、Host 和 TLS 状态，不以 X-Forwarded-* 建立信任。网页无需读取 JWT。Bearer 客户端发送 `Authorization: Bearer ...`，并从响应的 `X-IM-Token`、`X-IM-Token-Expires-At` 保存新令牌。时间戳为 Unix 毫秒。

JWT 使用 HS256，严格验证签名、算法、sub、iss、aud、iat、exp，载荷没有密码。每个通过认证的请求重新签发到期时间为当前时间加七天的 JWT；JWT 时间精度为秒，接口返回对应的毫秒时间戳。过期令牌不能续期。退出只清客户端令牌，未过期副本仍可使用和续期，没有即时撤销或绝对登录时限。认证错误返回 `401`，输入错误 `400`，注册冲突 `409`；所有响应禁止缓存。

需要身份的请求拒绝 Cookie/Bearer 同时出现、重复 Authorization 或重复 im_token。登录及真人注册只使用提交的注册/登录信息，忽略旧凭据；失败登录不续期旧令牌。退出允许过期或缺失令牌，以便清理客户端 Cookie。

若历史库已有真人但没有账号，只能由有权读取本机私有数据库配置的操作者显式指定 participant_id 绑定，不会任意选择一个真人。没有公开的“按 participant_id 接管”接口；绑定不会覆盖已存在的账号。以下方式通过隐藏输入读取密码，不将密码放入参数或 shell 历史：

```sh
python3 -c 'import getpass,json,sys; print("Human participant ID: ",end="",file=sys.stderr,flush=True); pid=input().strip(); print("Username: ",end="",file=sys.stderr,flush=True); print(json.dumps({"participant_id":pid,"username":input(),"password":getpass.getpass()}))' | go run ./backend/im/cmd -config localdeploy/im/config.json -bind-human-account
```

## Agent 管理与归属

`participant_accounts` 保存 `kind` 和可空 `owner_participant_id`，注册事务同时写入与 `participants.kind` 一致的类型。Agent 的 owner 必须是已注册真人；没有修改类型、转移归属或删除账号的入口。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `GET /agents` | 已登录真人 | `200 {agents: AgentAccount[]}`，仅自己的 Agent |
| `POST /agents` | `{name,username,password}` | `201 {agent: AgentAccount}` |
| `PATCH /agents/:participant_id` | 非空 `{name?,username?,password?}` | `200 {agent: AgentAccount}`，仅 owner 可修改 |

`AgentAccount` 只有 `participant_id,kind,name,username,owner_participant_id,created_at`，不含密码。创建、更新不切换当前身份，沿用七天续期；重设密码不会即时撤销已签发 JWT。用户名仍全局唯一，更新显示名和凭据在同一事务中完成。

`GET /participants` 的响应格式不变。真人只能看到自己和自己的 Agent；Agent 只能看到所属真人及同主 Agent。创建单聊、拉群、加人、移除和 @ 也校验相同 owner。会话列表及历史仍要求成员身份，不提供跨真人共享群。已有 `/auth/register` 的 agent 分支执行同样的 owner 校验。

## 本机数据库结构维护

已有数据库需要改表时，先用 `localdeploy/im/stop.sh` 停止 IM 并保留独立的 MySQL 运行，将需要保留的数据备份到仓库外，再在本机直接执行所需 SQL。同步更新 `sql/schema.sql` 和受影响的服务代码，再用 `localdeploy/im/start.sh` 重新构建、启动最新服务并验证。

`sql/schema.sql` 保存当前完整表结构，供阅读和新建空库使用。仓库不维护迁移脚本或自动改表流程，启动脚本不执行 SQL。

## 验证

```sh
go build ./backend/im/...
go vet ./backend/im/...
IM_TEST_MYSQL=1 go test -race -count=1 ./backend/im/...
```

自动化 MySQL 测试创建一次性私有数据目录和 socket，关闭网络监听，测试完成后自动关闭进程并删除目录。包含原有 Handler/聊天业务/SQL 场景、并发单聊复用、跨连接池的会话内序号分配、计数器回滚与重启、UUID 与时间顺序相反时的分页、Trigger UUID 字段约束、发消息与成员变更、取消及回滚、64 路重复关闭、注册原子性、JWT 严格验证与受控时钟续期、Cookie/Bearer 隔离、私有密钥复用，以及真实 HTTP 监听到数据库和重启的验证。另有多真人管理、跨 owner 拒绝、并发账号唯一性与局部更新验证。测试账号只存在于隔离测试库。
