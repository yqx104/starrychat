# Adaptor 会话管理与 Pi RPC 接入设计

日期：2026-11-14

状态：本期 MVP 已按本文实现。以下“当前模块现状”和草案说明保留设计时的基线；最终运行方式与接口见 [adaptor README](../adaptor/README.md)。

实施收敛：运行配置只在 `sessions` 中保存，已有配置需停用后修改；异常实例不自动重启，由用户停用／启用恢复。派发每 2 秒补扫，明确暂时拒绝按 1–30 秒退避；Pi 状态检查独立保持 10 秒。事件每会话缓存最近 300 条，通过带 epoch 的轮询接口读取，后端重启后清空。输入以带本地 ID 的完整信封和 Pi 已持久化 user 文本核对；无法关联时暂停，并提供停用后人工确认重试／已接收的操作。已有收件库按 AGENTS.md 停服并备份到仓库外，在本机直接调整结构，重新构建启动并验证后删除备份；仓库只维护当前完整 schema，不维护迁移脚本或迁移版本记录。

adaptor 负责 Agent 身份、账号接入、harness 选择和会话管理。pi-adaptor 作为 adaptor 后端引用的库，封装 Pi 原生 `RpcClient`，通过 RPC 操作一个具体的 Pi session。一个 adaptor 后端可以管理多个 Agent，每个已加载的 Pi session 对应一个 `RpcClient` 和一个 Pi RPC 进程。

本期只实现 adaptor 与 pi-adaptor 的 MVP 链路：IM 消息经 Trigger 和 inbox 派发到 Agent 的 Pi 主 session，默认插队；接收回执和执行事件返回 adaptor，供状态管理和前端展示。主子 session 与 IM 发言本期不实现。

## 1 已确定的约定

| 事项 | 约定 |
| --- | --- |
| Agent 身份 | IM 是账号与身份的来源。adaptor 使用 Agent 账号登录 IM，保存身份凭据、接入配置和会话绑定。 |
| 主 session | 每个 Agent 有一个当前主 session。单聊、群聊投递给该 Agent 的消息，都进入这个主 session，并保留来源信息。 |
| harness | adaptor 知道 Agent 使用哪个 harness，并能定位其主 session。每个 session 记录自己的 harness，为后续子 session 使用不同 harness 留出位置。 |
| Pi 接入 | 使用仓库内 Pi 的原生 RPC 和现成 `RpcClient`。不自建封装 SDK 的 worker 进程，也不重新设计一套进程通信协议。 |
| pi-adaptor 形态 | 独立 TypeScript 模块，作为库运行在 adaptor 后端进程内。每个会话对象封装一个 `RpcClient`，实际执行进程运行 Pi 原生 RPC 入口。 |
| Agent 启停 | 复用现有 `agents.enabled`。启用时连接 Trigger 并打开配置完整的主 session；停用时断开 Trigger、停止派发并关闭 Pi RPC。 |
| 实例数量 | 两个 `enabled=true` 且配置完整的 Pi Agent，对应两个主 session 和两个 Pi RPC 实例。以后并行子 session 使用额外实例。 |
| 消息调度 | 默认 `steer`。空闲时开始执行，忙碌时将新消息插入当前执行过程。 |
| 状态检查 | 每个已打开的 Pi RPC 实例每 10 秒调用一次 `getState()`，成功时刷新状态，失败时通知 adaptor 更新会话状态。 |
| run 语义 | adaptor 首版不建立独立的 run 业务模型，不要求一条 IM 消息对应一个 run。维护输入投递和 session 状态即可。 |
| 主子 session | 本期不实现。后续父子关系、归属、创建决策的执行和派活状态由 adaptor 维护，pi-adaptor 只操作具体 session。 |
| 会话延续 | 重新认证、Token 续期、Trigger 重连以及进程重启，不应自动创建新的主 session。恢复原有绑定和历史。 |

IM 登录凭据与模型访问凭据是两套配置。Agent 登录 IM 成功，只证明身份可用；Pi 是否具备模型调用能力需要单独检查。

## 2 当前模块现状

当前代码已接通以下接收链路：

```text
IM 业务事务与 trigger_outbox
  → Trigger 注册、订阅和消息投递
  → Agent WebSocket
  → adaptor SQLite inbox
  → 落盘后 ACK
```

| 模块 | 已有能力 | 本次接入缺少的部分 |
| --- | --- | --- |
| IM 后端 | 账号、会话、消息，以及向 Trigger 同步的持久化队列。 | Pi 执行接入不需要放进 IM。 |
| Trigger | Agent 鉴权、订阅路由、WS 投递、ACK 和断线补发。 | 保持消息投递职责，不管理模型 session。 |
| adaptor 后端 | Agent 登录、重新认证、连接启停、凭据续期、收件落盘与去重。 | harness 配置、主 session 绑定、运行实例管理和输入派发。 |
| adaptor 前端 | Agent 列表、连接状态、账号接入和收件箱；消息显示待执行。 | harness 配置、session 状态、执行输出与运行控制。 |
| `client/pi-adaptor` | 仅有占位文件。 | RPC 客户端封装和事件适配。 |
| `agents/pi` | 本地维护的 Pi 源码和构建配置，包含 RPC 实现与客户端。 | 与项目运行配置、会话定位和生命周期的连接。 |

adaptor 当前 SQLite 只有 `agents` 和 `inbox` 两张表。现有代码中的 `agents.enabled` 只控制是否连接 Trigger，`inbox.state` 当前一直是 `pending`。本设计将 `enabled` 扩展为统一的 Agent 启停开关，实际连接状态和 session 运行状态仍分别记录；这些代码改动尚未实现。

根 README 中“IM 到 Trigger 尚未接通”等描述已经落后于代码，后续更新模块说明时需要同步修正。Pi 执行入口和统一 IM CLI 仍未接入，不能把接收链路完成描述成 Agent 已能处理并回复消息。

## 3 总体架构与职责

```text
adaptor 后端进程
├── 账号与连接管理
│   └── Agent 身份、IM 凭据、Trigger WS
├── 会话管理与输入派发
│   └── Agent → 主 session，输入投递记录，后续父子关系
├── Agent A 的 pi-adaptor 会话对象
│   └── RpcClient A ── stdin/stdout JSONL ── Pi RPC 进程 A
│                                           └── Pi session A
└── Agent B 的 pi-adaptor 会话对象
    └── RpcClient B ── stdin/stdout JSONL ── Pi RPC 进程 B
                                            └── Pi session B

持久化
├── adaptor SQLite：身份、配置、会话绑定、输入与派发状态
└── Pi 会话文件：对话历史、工具记录、上下文压缩等原生数据
```

| 归属 | 职责 |
| --- | --- |
| adaptor 后端 | 选择消息目标、决定何时启动和关闭会话、保存绑定、维护运行状态和输入恢复信息；后续管理子 session 与派活。 |
| pi-adaptor | 将通用会话操作转换为 Pi RPC 调用；转换配置、会话引用和事件；报告启动失败、命令错误及进程异常。 |
| Pi RPC 进程 | 持有当前 Pi session，执行模型和工具，处理 steering、上下文压缩及 Pi 原生历史持久化。 |
| adaptor 前端 | 展示账号连接与会话运行状态，配置 harness，提供会话控制和执行过程查看。 |

adaptor 不解析 Pi 历史来重新构造一套模型上下文。Pi 会话文件由 Pi 读写；需要查询原生记录时，通过 pi-adaptor 暴露的能力访问。

同一个 session 同时只允许一个有效的运行实例。后续 Codex 等适配器可以通过各自 SDK 或 App Server 实现相同的业务边界，不要求它们采用与 Pi 相同的进程和存储方式。

## 4 pi-adaptor 模块架构

### 4.1 目录与依赖

建议目录如下，文件名可随实现规模调整：

```text
client/pi-adaptor/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts       导出会话对象和工厂
│   ├── session.ts     封装 RpcClient 与单个会话的生命周期
│   ├── events.ts      将 Pi 事件映射成 adaptor 使用的事件
│   └── types.ts       配置、会话引用、输入回执与事件类型
└── tests/             RPC 封装、事件和生命周期验证
```

pi-adaptor 依赖仓库内的 `@earendil-works/pi-coding-agent`，运行入口使用这份本地 Pi 的构建产物。adaptor 后端引用 pi-adaptor；IM、Trigger 和其他 harness 的适配器不因此依赖 Pi。

新增模块需要加入根 `package.json` 的 workspaces，并补充依赖、构建命令和锁文件。pi-adaptor 不需要独立 HTTP 服务、端口或自定义 worker 入口。

### 4.2 对外能力

以下是最小方法草案，返回类型在实现时收敛：

| 方法 | 语义 |
| --- | --- |
| `open(config)` | 按明确的新建或恢复意图启动 Pi RPC，检查可用状态，返回会话引用。 |
| `sendInput(input)` | 提交带本地输入 ID 的内容，默认使用 `steer`，返回接收结果。 |
| `onEvent(listener)` | 订阅文本、工具活动、队列变化、状态与错误等事件。 |
| `getState()` | 读取会话运行状态及原生会话定位信息。 |
| `abort()` | 停止当前执行，保留会话及运行进程。 |
| `close()` | 释放运行实例，退出 Pi 进程，保留持久化历史。由 Agent 停用、后端关闭等生命周期流程调用。 |

`sendInput()` 返回的是输入回执，不是任务结果。Pi 的 `started`、`queued`、`handled` 应保留其含义；`handled` 可能是扩展消费了输入，并不代表为这条输入启动了模型执行。

adaptor 负责把 IM 消息组织成带来源的输入。pi-adaptor 接收通用内容，不负责查询 IM 账号、决定主 session 或维护全部 Agent 的注册表。

### 4.3 RPC 调用方式

恢复已有会话的核心调用如下。示例省略配置校验、绑定存储、输入关联和关闭流程：

```ts
import { RpcClient } from '@earendil-works/pi-coding-agent';

const rpc = new RpcClient({
  cliPath: config.piCliPath,
  cwd: config.cwd,
  env: { PI_CODING_AGENT_DIR: config.piConfigDir },
  args: ['--session', config.sessionFile],
});

rpc.onEvent(event => forwardEvent(event));
await rpc.start();

const state = await rpc.getState();
// 核对 state.sessionId；state.sessionFile 确认存在后再持久化为恢复路径。

const disposition = await rpc.prompt(input.text, undefined, 'steer');
// disposition 只说明输入被启动、排队或处理，后续继续接收事件。
```

`RpcClient` 已负责启动子进程、JSONL 读写和请求响应关联。pi-adaptor 复用这些能力，具体实现依据仓库内固定版本，不混用其他版本的 SDK 示例。

### 4.4 配置与会话定位

每个会话需要明确工作目录、Pi 配置目录、会话存储位置、模型选择和扩展配置。不同 Agent 的会话文件分开保存；工作目录可以指向同一项目，但共享目录中的文件修改仍需要业务层协调。

adaptor 保存自己的逻辑 `session_id`，同时保存 pi-adaptor 返回的原生引用，例如 Pi session ID 和文件路径。恢复使用精确引用，避免通过 `--continue` 选择同一目录里最近的会话。主 session 使用持久化模式，不使用 `--no-session`。

新建空会话时，Pi 可能已分配 ID 和路径，但尚未生成文件。先保存稳定的 Pi session ID，首次创建使用独立目录与 `--session-id`；RPC 返回的文件路径在确认文件存在后，再保存为持久恢复路径。目录按本机数据根目录和逻辑 session ID 确定，不重复存一份。

已保存的恢复路径缺少文件时报告异常，不能静默替换为空上下文。尚未保存路径时，先在该 session 的目录内按原生 ID 查找，覆盖文件已生成、路径尚未来得及保存的情况；确认为未使用的空会话才允许继续初始化。若投递记录显示可能已有输入被处理而历史无法确认，转入恢复处理。首版不额外保存历史初始化标记。

### 4.5 现成客户端的接入边界

当前 `RpcClient.start()` 只做短暂启动等待，pi-adaptor 应再通过 `getState()` 确认 RPC 可用，并核对会话身份后才允许派发输入。

当前 `RpcClient.stop()` 会发送 SIGTERM，约一秒后可能强制退出。关闭流程需要结合 `abort()`、输入恢复记录和合理的退出等待验证，不能把 `stop()` 返回解释成所有工作已完成。

进程退出目前会让待处理 RPC 请求失败，但没有等待中请求时，adaptor 也需要发现异常。首版使用周期性状态探测：pi-adaptor 在会话打开成功后，每 10 秒调用一次 `getState()`，空闲和执行期间都检查。成功时刷新会话状态；失败或超时时向 adaptor 报告异常。探测失败不直接等同于已确认进程退出，后续恢复策略单独处理。

同一实例最多保留一个在途检查，上一轮尚未结束时跳过本次定时触发，避免请求堆积。关闭实例前停止定时检查，并忽略已关闭或已被替换实例的迟到结果。10 秒是检查间隔，不是故障发现的最大时限，RPC 响应超时另行计算。首版复用现有 `getState()`，不为退出通知修改 Pi 客户端或 RPC 协议。

## 5 会话与进程生命周期

主 session 首版按常驻方式实现：Agent 的 `enabled=true` 且配置完整时启动，执行结束后保持空闲，等待后续消息。`enabled` 表达用户希望这个 Agent 启用还是停用，不代表 Trigger 此刻已经连接成功，也不代表 Pi 此刻没有故障。会话历史长期保存，进程是当前的运行载体。

| 时机 | 行为 |
| --- | --- |
| Agent 首次接入 | 沿用现有默认 `enabled=true`，建立 Trigger 连接；Pi 配置完整时创建主 session 绑定并打开会话，否则显示待配置并先保存收到的消息。 |
| 已启用 Agent 补齐 Pi 配置 | 打开主 session，派发此前明确尚未投递的本地输入。 |
| adaptor 后端启动 | 为 `enabled=true` 的 Agent 恢复 Trigger 连接，并打开配置完整的主 session；`enabled=false` 的 Agent 保持停用。Pi 启动失败只影响对应会话，接收链路继续工作。 |
| 新 IM 消息到达 | 路由到原主 session；空闲时开始工作，忙碌时 steer。 |
| 当前执行结束 | 更新为空闲，保持进程和会话。 |
| Token 续期、重新认证、WS 重连 | 更新账号或连接状态，继续使用原会话。 |
| 关闭浏览器页面 | 后端接收与 Pi 进程继续运行。 |
| 用户停用 Agent | 保存 `enabled=false`，停止向会话派发并断开 Trigger，中止当前执行、保留未消费输入的恢复信息，再关闭 Pi 进程；保留收件记录、历史和绑定。 |
| 用户重新启用 Agent | 保存 `enabled=true`，重新连接 Trigger，并在配置完整时恢复原主 session，继续处理明确尚未投递的输入。 |
| Trigger 意外断线 | 保持 `enabled=true` 并按连接策略重连；Pi 进程和正在进行的工作继续运行。 |
| adaptor 后端关闭 | 停止接收与派发，等待各会话关闭和状态落盘，最后关闭 SQLite。 |
| Pi 进程异常退出 | 标记会话异常，保留 `enabled`、会话引用和输入记录，Trigger 可继续收件；重新启动时恢复原 session。 |

复用现有 `PATCH /agents/{id}` 的 `enabled` 参数，同时协调 Trigger 连接和 Pi 运行，不新增独立运行开关。前端“启用／停用连接”改为“启用／停用 Agent”。启用时 Pi 的启动不必等待 Trigger 达到 `online`；网络断线或 Pi 故障也不自动把 `enabled` 改为 false。

前端仍分别展示 Trigger 连接状态和 session 运行状态，因为统一启停不意味着两者永远同时正常。“中止当前执行”保留为独立操作：调用 `abort()`，不修改 `enabled`，也不关闭连接和 Pi 进程。

实例停止不会删除 session，恢复历史也不会自动续上已中断的系统命令。自动重启次数、退避间隔和关闭超时属于运行策略，具体值在实现时确定。

## 6 消息派发与默认插队

### 6.1 Dispatcher 的职责和数量

新增 `backend/src/service/dispatch.ts`，由 `main.ts` 在启动时创建一个 Dispatcher，注入存储层和会话管理模块。一个 adaptor 后端共用这个 Dispatcher，由它负责从 inbox 取输入、找到目标会话对象、提交输入和保存回执。它运行在后端进程内，不需要独立进程。

Dispatcher 按 session 分别维护派发状态。首版每个 Agent 只有一个主 session，因此表现为各 Agent 独立投递；以后同一个 Agent 的主、子 session 也可独立推进。

```text
一个 adaptor 后端
└── 一个 Dispatcher
    ├── session A 的派发流程 → pi-adaptor 对象 A → Pi RPC A
    ├── session B 的派发流程 → pi-adaptor 对象 B → Pi RPC B
    └── session C 的派发流程 → pi-adaptor 对象 C → Pi RPC C
```

每个 session 同时最多有一个派发流程，按本地收件顺序逐条提交。不同 session 的流程以异步 I/O 并发推进：A 在 `await sendInput()` 等回执时，Node 可以继续给 B 发输入、处理 B 的回执。Dispatcher 不能等待 A 的整批消息结束后才开始 B。

```text
时间向右 →
session A：发送 A1 ───── 等待回执 ───── 发送 A2
session B：发送 B1 ─ 等待回执 ─ 发送 B2 ─ 等待回执
```

这些是同一后端中的异步流程；模型和工具执行在各自的 Pi RPC 进程内。每条输入只等 RPC 接收回执，不等模型完成，因此同一 session 正忙时也能继续接收插队消息。

Dispatcher 的内存状态只记录哪些 session 正在派发、需要再次检查或暂时受阻。待投递内容和投递进度以 SQLite 为准，不另外维护一份只存在内存里的消息队列。

### 6.2 如何唤醒派发

唤醒表示“检查这个 session 是否有可投递输入”，不直接把通知里的消息作为唯一的数据来源。

| 时机 | 唤醒方式 |
| --- | --- |
| 新消息落盘并 ACK Trigger 后 | `connections.ts` 通知 Dispatcher 对应的 `agent_id`；Dispatcher 通过会话管理模块定位主 session。 |
| adaptor 后端启动 | 扫描 `enabled=true` Agent 的待投递记录；尚未打开的 session 保留记录，等待就绪。 |
| Agent 重新启用、配置补齐或 session 恢复成功 | 会话管理模块在实例可接收输入后，通知 Dispatcher 检查对应 session。 |
| 暂时不可投递的原因消失 | 例如压缩结束、会话恢复可用或到达重试时间，再次唤醒对应 session。 |
| 后台补扫 | 定期检查仍待投递的记录，补偿遗漏的通知。补扫间隔尚未确定，和每 10 秒调用 `getState()` 的状态检查分别配置。 |

没有主 session 绑定时，输入先保留在 inbox。绑定建立且会话就绪后，再定位和派发。重复通知可以合并；一条消息是否需要提交，最终由数据库中的投递状态决定。

同一 session 的唤醒按以下方式处理：

1. 记录该 session 需要检查。若它没有正在运行的派发流程，就启动一个。
2. 若已有流程，只记录一次再次检查的需求，不创建第二个并发流程。
3. 现有流程收到回执后继续读库。准备退出前检查期间收到的唤醒，避免新消息恰好到达时漏掉处理。
4. Agent 已停用、session 未就绪或正在等待恢复时，结束本轮并释放派发标记，等待后续有效唤醒；不因为表里还有消息就不断重试。

唤醒丢失不丢失消息：SQLite 中的待投递记录仍在，补扫和后续恢复扫描会再次发现它。停用 Agent 时停止为它启动新的派发；重新启用时再检查积压记录。

### 6.3 从 inbox 到 RPC 的完整调用链

```text
connections.ts
  → Store.receive() 保存消息到 inbox
  → ACK Trigger
  → 唤醒 Dispatcher

dispatch.ts
  → 从 inbox 取待投递记录
  → 根据 agent_id 定位主 session
  → 从 sessions.ts 取得这个 session 的运行对象
  → 调用 pi-adaptor.sendInput()
      → RpcClient.prompt(..., 'steer')
      → 通过 stdin 将命令交给对应 Pi RPC 进程
  ← 等待该命令的接收回执
  → 更新 inbox 投递状态
  → 继续取该 session 的下一条输入
```

会话管理模块维护两层关系：数据库通过 `sessions.agent_id` 找到该 Agent 唯一的主 session，内存记录 `session ID → 已打开的 pi-adaptor 会话对象`。会话对象内部持有对应的 `RpcClient`。Dispatcher 复用这个对象，不为每条输入新建 Pi 进程。这里的会话管理模块是 adaptor 自己的 `sessions.ts`，与 Pi 内部保存历史的 `SessionManager` 分属不同职责。

一条输入的具体提交步骤如下，状态名是实施草案：

1. 确认 Agent 仍为 `enabled=true`，目标会话对象存在且可接收输入。Pi 正在执行不等于不能接收，默认使用 steer；尚未启动或正在关闭时不取新消息。
2. 按该 session 的 `agent_id` 查 inbox，以本地 ID 升序取待投递队首。首版每个 Agent 只有一个固定主 session，不在每条输入中重复保存目标 session。
3. 条件更新记录，将 `pending` 改为 `sending`；更新成功才调用 RPC。本次调用的令牌和实例代次保留在内存，数据库事务不跨越等待 RPC 的过程。
4. 从 `message_json` 组织输入，保留原消息 ID、来源会话、发送者和引用关系，调用对应对象的 `sendInput()`。
5. 收到接收回执后，先核对内存中的调用令牌和实例代次，再按输入 ID 及 `state=sending` 条件更新为 `accepted`，保存 `started`、`queued` 或 `handled` 等结果。旧流程失效后不能修改新流程的记录。
6. 回到读库步骤，继续下一条。同一个 session 保持提交顺序，其他 session 无需等待这一条。

提交前还需校验启用状态及运行对象仍然有效。停用或替换实例后，旧流程不能继续发送下一条；已经发出的请求按回执或异常恢复规则处理。同一 SQLite 由一个 adaptor 后端管理，每个 session 只有一个派发流程；重试前先结束或使旧流程失效，因此不需要持久化投递尝试 ID。内存令牌只防止迟到结果写入，不是业务 run。

IM 的 `message_seq` 只在同一来源会话内有效，不能用它排序多个群聊和单聊的全部输入。若队首暂时被明确拒绝而需要重试，本轮先暂停该 session，后续输入不越过它；其他 session 继续派发。

收到重复 Trigger 消息时补 ACK，去重记录与条件更新防止重复提交。RPC 调用不放在 WS 落盘 ACK 的关键路径中；派发失败不应被报告成收件落盘失败。即使 ACK 后、唤醒前进程退出，恢复扫描仍能从 inbox 找到未派发输入。

### 6.4 默认插队

使用 `prompt(..., 'steer')`。Pi 空闲时启动执行；运行中收到的新输入进入 steering 队列，在当前 assistant turn 及其工具调用结束后、下次模型调用前参与上下文。它不会直接杀掉正在运行的命令；明确停止由 `abort()` 表达。

自动压缩等阶段可能暂时不能接受普通 prompt。明确未受理的输入保留在 adaptor，等待可接收后再投递，不能丢弃或误记为已完成。

一条输入可能改变当前工作的范围，多条输入也可能共同影响一段连续执行。因此不建立“每条 IM 消息一个 run”的强制映射。

### 6.5 回执与执行事件分开处理

Pi stdout 上的 JSONL 同时包含命令响应和会话事件。现成 `RpcClient` 已按请求 ID 分流，Dispatcher 不根据文本、工具或 turn 事件推测某条输入是否被受理：

```text
Pi JSONL response（带请求 ID）
  → RpcClient 匹配等待中的请求
  → prompt() 返回接收结果或报错
  → pi-adaptor.sendInput() 返回
  → Dispatcher 更新对应 inbox 记录

Pi JSONL 执行事件
  → RpcClient.onEvent()
  → pi-adaptor 整理事件
  → adaptor 更新会话状态、记录或展示执行过程
```

`sendInput()` 需将本地输入 ID 与这次方法调用关联。原生 `RpcClient` 自己分配 RPC 请求 ID，用于匹配响应；会话事件通常没有对应单条输入的请求 ID。未匹配到待处理请求的迟到 `response` 也可能进入原生事件回调，pi-adaptor 要识别其类型，不将它当作普通执行内容或直接覆盖新的投递状态。

| 返回情况 | Dispatcher 的处理 |
| --- | --- |
| `started` | 记录输入已接受并启动执行，然后继续取下一条。 |
| `queued` | 记录输入已接受并进入 steering 队列，然后继续取下一条；不标记任务完成。 |
| `handled` | 记录输入已被扩展等机制处理，然后继续取下一条；不等待这条输入必然产生模型输出。 |
| 明确拒绝且可重试 | 保存原因，保留待投递状态，在阻塞原因消失或重试时间到达后重新检查；本轮不越过它。 |
| 明确拒绝且需要修改配置或输入 | 标记拒绝并报告原因，暂停该 session 的自动派发，等待问题处理。 |
| 超时、连接中断或退出导致结果不确定 | 标记待恢复，暂停该 session 的自动派发并保留原记录；不立刻重发。 |

异常应由所属 session 的派发流程处理，释放本轮派发标记，不能让一个 Agent 的错误终止其他 Agent 的流程。暂停派发不自动修改 `enabled`；处理完成后的唤醒与恢复使用同一份持久化记录。

需要区分以下时刻：

| 信号 | 表示什么 |
| --- | --- |
| Trigger ACK | 消息已保存到 adaptor 本机。 |
| RPC prompt 成功响应 | 输入已启动、排队或被扩展处理。 |
| 输入进入 Pi 持久化历史 | 对话历史中已记录这条输入，需要可核对的关联证据。 |
| `agent_settled` | Pi 当前不会继续自动执行，可据此结合状态查询更新空闲状态。 |
| 后续 Task 完成 | 某个派活任务交付结果，由业务协议约定。 |

`agent_end` 之后还可能重试、压缩或继续消费队列，不作为最终空闲信号。`agent_settled` 也不能直接给所有输入标记“任务完成”。

### 6.6 输入恢复

SQLite 收件去重不能保证模型和工具只执行一次。RPC 请求 ID 用于匹配响应，不是跨进程重启的业务幂等键。

明确尚未投递的消息可以继续投递。请求发出后未收到回执，或已收到 `queued` 回执但进程随后退出，都可能无法直接判断输入是否已进入历史。首版保留原消息和投递状态，将不能判定的记录标为待恢复，不自动重放整条任务。

重启扫描不能把遗留的 `sending` 一律改回 `pending`：请求可能已经被 Pi 接受。先将这类记录纳入恢复处理，再决定能否继续派发。保留已有状态、接收回执和错误原因；未知结果没有核对清楚前，不自动越过它推进该 session 的后续输入。

未处理的拒绝或待恢复记录所形成的派发暂停条件，也要在重启时从持久化记录恢复，不能只依赖内存标记。输入问题已解决、经过核对并更新投递状态后，再唤醒对应 session。重试计时和次数保留在内存，重启后可重新计时，不影响持久化消息和阻塞状态。

后续可通过输入 ID 与 Pi 历史的可靠关联来缩小不确定范围。关联方式需要在实现时验证；不能只因 RPC 返回成功，就删除本地记录或假设 steering 队列已持久化。

## 7 现有模块改动

### 7.1 adaptor 后端

| 位置 | 改动 |
| --- | --- |
| [schema.sql](../adaptor/backend/sql/schema.sql) | 增加会话配置、主 session 绑定和输入投递字段；保留账号凭据及收件去重约束。 |
| [store.ts](../adaptor/backend/src/repository/store.ts) | 集中执行 SQLite 读写、事务、收件去重与原子状态更新；公共响应由业务层隐藏凭据。 |
| [connections.ts](../adaptor/backend/src/service/connections.ts) | 协调收件落盘后 ACK，并通知派发模块；底层连接、心跳、重连及协议收发由 `clients/trigger.ts` 负责。 |
| [server.ts](../adaptor/backend/src/http/server.ts) | 创建 HTTP 服务并分发账号、会话接口，统一处理错误；`http/agents.ts`、`http/sessions.ts` 调用业务层，账号接入与启停流程在 `service/agents.ts`，会话配置、恢复和生命周期在 `service/sessions.ts`。 |
| [config.ts](../adaptor/backend/src/config/config.ts) | 增加运行数据根目录、Pi CLI 定位等本机配置；每个 session 的运行配置由存储层管理，只保存一份。 |
| [main.ts](../adaptor/backend/src/cmd/main.ts) | 组装会话管理与 pi-adaptor，按 `enabled` 恢复连接和配置完整的主 session；退出时先完成异步清理，再关闭数据库。 |
| [init-db.ts](../adaptor/backend/src/cmd/init-db.ts) | 使用当前完整 schema 显式初始化空库，拒绝覆盖已有库；已有库按 AGENTS.md 停服后在本机直接调整结构，服务启动只检查结构。 |
| 新增会话管理模块 | 根据 Agent 的 `enabled` 和配置协调主 session 的启动关闭；维护运行句柄与实际状态，防止重复打开同一 session。 |
| 新增输入派发模块 | 后端创建一个 Dispatcher，按 session 并发派发；合并唤醒，从 inbox 领取输入、调用会话对象、处理回执和恢复。具体流程见第六节。 |

会话管理与输入派发分别位于 `backend/src/service/sessions.ts`、`backend/src/service/dispatch.ts`，会话工厂位于 `backend/src/clients/harnesses.ts`。`harnesses.ts` 只需提供从 `harness=pi` 到会话工厂的选择，首版不引入复杂插件注册框架。

### 7.2 数据表改动

| 表 | 字段 | 变更 | 类型与约束 | 说明 |
| --- | --- | --- | --- | --- |
| `agents` | `enabled` | 扩展语义，结构不变 | `INTEGER NOT NULL DEFAULT 1`，只允许 `0/1` | 统一控制 Trigger 连接和主 session 运行。 |
| `sessions`（新表） | `session_id` | 新增 | `TEXT PRIMARY KEY` | adaptor 生成的稳定逻辑会话 ID。 |
| `sessions` | `agent_id` | 新增 | `TEXT NOT NULL UNIQUE REFERENCES agents(agent_id)` | 所属 Agent；首版每个 Agent 最多一个主 session。 |
| `sessions` | `harness` | 新增 | `TEXT NOT NULL`，无默认值 | 适配器类型，首版为 `pi`。 |
| `sessions` | `cwd` | 新增 | `TEXT NOT NULL`，无默认值 | 工作目录的绝对路径。 |
| `sessions` | `config_json` | 新增 | `TEXT NOT NULL DEFAULT '{}'`，内容为 JSON 对象 | 会话的 harness 配置，如 Pi 配置目录、模型选择；密钥保存在本机私有配置中。 |
| `sessions` | `native_ref_json` | 新增 | `TEXT DEFAULT NULL`，非空时为 JSON 对象 | 原生会话引用。Pi 保存 `session_id`、`session_file`；文件确认存在后补齐路径，之前路径为 `null`。 |
| `inbox` | `state` | 扩展允许值 | 保留 `TEXT NOT NULL DEFAULT 'pending'`；允许 `pending`、`sending`、`accepted`、`rejected`、`needs_recovery` | 分别表示待投递、等待回执、已接受、明确拒绝、待恢复。 |
| `inbox` | `receipt_disposition` | 新增 | `TEXT DEFAULT NULL` | 接收回执：`started`、`queued` 或 `handled`。 |
| `inbox` | `last_error` | 新增 | `TEXT DEFAULT NULL` | 最近失败或待恢复的原因。 |

其余现有字段及约束保持不变，包括 inbox 的 `UNIQUE(agent_id, message_id)` 和 `inbox_agent_id(agent_id, id)` 索引。

### 7.3 HTTP 与前端

现有账号接入、重新认证和收件箱接口继续使用；现有 `PATCH /agents/{id}` 扩展为统一启停。新增 API 的路径是草案：

| 能力 | 路径示意 | 用途 |
| --- | --- | --- |
| 启用或停用 Agent | 现有 `PATCH /agents/{id}`，请求 `{enabled:boolean}` | 同时控制 Trigger 连接和主 session 运行。 |
| 读取或修改运行配置 | `GET/PATCH /agents/{id}/runtime` | harness、工作目录与配置引用；不设置第二个启停开关。 |
| 读取主 session | `GET /agents/{id}/main-session` | 获取逻辑 session、状态和可展示的定位信息。 |
| 中止当前执行 | `POST /sessions/{id}/abort` | 保留会话和进程，停止当前工作。 |
| 读取执行事件 | 会话事件接口，传输方式待实现时确定 | 文本、工具进度、状态变化和错误。 |

首版主 session 的运行启停统一通过 Agent 的 `enabled` 控制，不再提供独立的主 session start/stop 接口。pi-adaptor 内部的 `open()` 和 `close()` 仍用于落实这个生命周期。

[api.ts](../adaptor/frontend/src/api.ts) 增加运行配置、session、输入回执和事件类型。[App.tsx](../adaptor/frontend/src/App.tsx) 增加以下能力：

- Agent 的 harness、工作目录和模型配置入口。
- 分别展示 Trigger 连接状态与 session 运行状态。
- 展示主 session，以及文本输出、工具活动和错误。
- 提供统一的“启用／停用 Agent”，另提供“中止当前执行”。
- 收件箱按实际投递状态展示，能够区分待投递、已接收和待恢复。

首版保留已有轮询也可以完成配置和状态展示。执行事件需要补充查询或流式接口，不能直接把 Pi stdout 暴露给浏览器；IM Token 和模型密钥不进入公开状态响应。

### 7.4 Pi 与项目配套

| 位置 | 改动 |
| --- | --- |
| [根 package.json](../../package.json) | 注册 `client/pi-adaptor` workspace，建立本地依赖和构建顺序，更新锁文件。 |
| [adaptor backend package.json](../adaptor/backend/package.json) | 引用新的 pi-adaptor 模块。 |
| [agents/pi](../../agents/pi/README.md) | 保持本地 Pi harness 来源；说明 RPC 运行入口与构建要求。 |
| 本机启停与配置 | 打开 Pi 会话前检查入口可用，失败不阻塞 adaptor 收件；停止时等待其管理的 Pi 进程退出；会话和私有配置保存在本机运行目录。 |
| README 与模块说明 | 更新已接通的 IM 同步现状，说明 RPC 接入、配置和验证方式。 |

本次主 session 接入不要求修改 IM 与 Trigger 的业务协议。跨服务测试可以增加 Pi 接入覆盖，但模型执行逻辑不进入 Go 服务。

## 8 本期不实现：主子 session 与 IM 发言

本节仅记录后续方向，不属于本期 MVP 的实现范围或验收项。主子 session 的创建与派活、任务结果回传，以及 IM 发言所需的 CLI 或工具桥接均留待后续实现。本期 Pi 的执行输出在 adaptor 前端展示。

后续实现主子 session 时，主 session 通过工具提出派活请求，adaptor 创建子 session 记录、确定 harness、打开运行实例并投递任务。子 session 的状态和结果经 adaptor 返回主 session，默认沿用插队语义。

```text
主 session 调用派活能力
  → adaptor 保存父子关系和任务
  → 创建对应 harness 的会话对象
  → 打开子 session 并发送输入
  → 子 session 上报结果
  → adaptor 向主 session 投递结果
```

Pi 侧的派活入口可以通过扩展或工具桥接 adaptor 的业务接口。RPC 用于控制 Pi，会话树和 Task 状态仍由 adaptor 管理。进入这一阶段时，再扩展一对多会话关系、主会话选择和输入目标字段；首版不提前预留。

子 session 默认属于同一个 Agent，不需要新的 IM 账号或 Trigger WS。Agent A 经 IM 给 Agent B 发消息，仍路由到 B 的主 session，不因此把 B 改为 A 的子 session。

Pi 的 `switch_session`、`new_session` 和 fork 能力操作当前运行实例的会话。并行子 session 要创建额外 RPC 实例。是否继承父上下文、如何传递摘要以及任务完成后何时释放子进程，作为子 session 阶段的设计内容。

一个 Task 可以经历多条输入和多段执行，完成依赖明确结果上报，不能直接等同于 Pi 的一次空闲事件。

IM 发言沿用项目的统一 IM 能力方向。当前只有触发和接收链路，统一 IM CLI 尚未实现。后续需要明确它的身份凭据获取、目标会话与引用关系；Pi 执行输出先作为运行事件，是否发送到 IM 由明确的发言操作表达，不能把所有 assistant 输出自动当作聊天回复。

## 9 本期 MVP 实施顺序与验证

本期验收链路为 `IM → Trigger → adaptor inbox → Dispatcher → pi-adaptor → Pi 主 session`，接收回执和执行事件返回 adaptor，完成状态更新与前端展示。

1. 实现 pi-adaptor 最小 RPC 封装，验证启动、精确恢复、状态查询、默认 steer、事件订阅、abort 和关闭。
2. 扩展 adaptor 存储与配置，建立 Agent 到主 session 的绑定，复用 `enabled` 统一启停，并分别记录连接和会话的实际状态。
3. 将现有 inbox 接入派发模块，保留落盘 ACK、去重和离线恢复能力。
4. 增加运行 API 和前端配置、控制、状态及事件展示。
5. 验证上述主 session 链路，以及多 Agent 并行派发、启停和恢复，完成本期 MVP 验收。

需要验证的关键行为：

- 两个 Pi Agent 各自打开独立 session 和进程，上下文、定位信息与状态不串。
- `enabled` 同时控制连接和主 session；停用后不再派发输入，重新启用及后端重启按该字段恢复，历史和收件记录保留。
- Trigger 意外断线时 `enabled` 保持 true，Pi 继续运行；Pi 启动失败或异常退出不阻塞 Trigger 收件。
- 同一 Agent 来自多个 IM 会话的消息进入同一个主 session，来源信息完整。
- Pi 正忙时第二条输入可被接收并 steer，当前执行不会阻塞输入提交。
- 一个 session 等待 RPC 回执或遇到错误时，其他 session 仍能投递；同一 session 的重复唤醒不产生第二个派发流程。
- ACK 后唤醒遗漏、退出前又有新输入到达及实例替换等情况下，补扫和派发状态仍能保留输入且避免重复领取。
- Pi 不可用不阻塞 SQLite 落盘和 Trigger ACK；重复投递不会重复提交输入。
- 重新认证、WS 重连与后端重启能够保持原会话绑定；存在历史时正确恢复上下文。
- 输入接收回执与执行事件分别处理；不会把 `queued` 或 `agent_end` 误判为业务完成。
- 正常关闭、空闲时异常退出、带未消费输入退出，都能显示正确状态并保留恢复所需记录。
- 每个已打开实例按 10 秒间隔检查状态；检查不重叠，关闭后不再检查，迟到结果不会覆盖新实例状态。
- 前端关闭不影响后台运行，公开接口不返回 IM Token 或模型密钥。

现有 [收件测试](../adaptor/backend/tests/receipt.test.ts) 与 [跨服务集成测试](../../server/backend/trigger/tests/adaptor_integration_test.go) 需要保留。测试应覆盖实际 RPC 协议和持久化边界；真实模型调用单独使用已配置的模型环境验证。

## 10 本期 MVP 实现时需要收敛的细节

以下细节尚未形成最终接口或策略，不影响前述职责划分：

| 事项 | 需要确定的内容 |
| --- | --- |
| 配置细节 | 运行配置仅在 `sessions` 保存一份；继续收敛各 harness 的 JSON 属性、私有凭据来源，以及修改当前会话配置时的生效方式。 |
| 输入恢复 | 如何把本地输入 ID 与 Pi 已持久化输入可靠关联；不确定输入的核对和重试交互。 |
| 派发调度 | 待投递记录的兜底补扫间隔和可重试拒绝的退避策略；与 10 秒一次的 Pi 状态检查分别配置。 |
| 运行策略 | 异常重启策略、退出等待时间；统一启停沿用现有 `enabled` 及新接入默认启用的行为，空闲回收留待有需要时增加。 |
| 事件展示 | 事件缓存或持久化范围、历史查询和前端传输方式。 |

## 11 代码与协议参考

- [adaptor 当前接收链路和接口](../adaptor/README.md)
- [Pi RPC 协议与生命周期](../../agents/pi/upstream/packages/coding-agent/docs/rpc.md)
- [Pi RPC 命令与输入回执](../../agents/pi/upstream/packages/coding-agent/docs/rpc-commands.md)
- [Pi CLI 会话参数](../../agents/pi/upstream/packages/coding-agent/docs/cli.md)
- [RpcClient 源码](../../agents/pi/upstream/packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [Pi RPC 命令处理](../../agents/pi/upstream/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [Pi 会话文件创建与持久化](../../agents/pi/upstream/packages/coding-agent/src/core/session-manager.ts)
- [Pi 本地 fork 来源与构建说明](../../agents/pi/upstream/README.md)
