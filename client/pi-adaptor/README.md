# Pi adaptor

`@starrychat/pi-adaptor` 实现 [adaptor 公共接口](../adaptor/contracts/README.md)，由 adaptor 后端的静态驱动列表注册。`createPiHarness()` 管理 Pi 配置、默认可执行路径、私有目录校验及原生会话引用。每个 `PiSession` 封装仓库内 Pi 的原生 `RpcClient`，启动一个 Pi RPC 子进程；没有独立 HTTP 服务或自定义进程通信协议。

源码按职责分为三个目录，`src/index.ts` 保持统一对外入口：

```text
src/
├── index.ts
├── harness.ts          # 公共接口实现、默认入口与原生引用创建
├── config/
│   ├── runtime.ts      # Pi 运行配置表单校验、读取、保存和目录布局
│   ├── files.ts        # 私有配置文件读写、原子替换与回滚
│   ├── selection.ts    # 默认 provider/model 选择
│   ├── models.ts       # 模型候选、接口、认证配置与组合保存
│   ├── mcp.ts          # 通用连接信息转换为 Pi 私有 MCP 配置
│   └── prompt.ts       # SYSTEM.md 读取与提示词校验
├── session/
│   ├── session.ts      # PiSession 生命周期、输入与状态检查
│   ├── events.ts       # 原生事件转换为可展示事件
│   ├── history.ts      # 会话文件定位、身份校验与历史输入读取
│   └── environment.ts  # RPC 子进程环境变量隔离
└── model/
    ├── types.ts        # PiSettings、Pi 原生引用和内部启动参数
    └── errors.ts       # 公共错误类型的兼容导出
```

依赖方向为 `session → config`，两者都可依赖 `model`；`config` 不依赖会话实现。配置类型与对应配置逻辑放在一起，内部直接引用具体文件。`saveModelConfiguration()` 仍统一保存模型、认证和提示词，并在失败时整体回滚。测试按 `tests/config/` 和 `tests/session/` 对应组织，公共 RPC 子进程夹具保留在 `tests/fixtures/`。

在项目根完成依赖安装及 Pi 模型目录准备后，执行 `npm run build:adaptor`。后端默认入口是 `agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js`；源码来源仍为本地 fork。Pi SDK 延迟到打开会话时加载，Pi 缺少构建或启动失败不会阻止 adaptor 收件。

公共 `Session`、`SessionEvent`、回执、MCP 连接和错误类型从 `@starrychat/adaptor-contracts` 引入；Pi 包导出 `createPiHarness`、`PiSession` 以及 Pi 专属配置与原生引用类型。公共服务使用 `createPiHarness()` 返回的配置管理和会话接口，不直接读取 Pi 文件。使用顺序是创建对象、保存 `nativeRef`、订阅 `onEvent()`、调用 `open()`，随后调用 `sendInput({id,text})`、`getState()`、`abort()`，最后 `close()`。一个对象只能打开一次；关闭后恢复需按同一 `nativeRef` 创建新对象。

- `open()` 先读取实例 `pi-config/settings.json` 的 `defaultProvider`、`defaultModel`，检查私有配置 JSON；使用环境变量白名单启动 RPC，再检查指定模型及认证是否可用。缺少配置抛出 `ConfigurationError`，检查失败会关闭进程。凭据来自实例 `auth.json`／`models.json`，不继承宿主机密钥、云认证链或工作目录模型设置；禁用凭据 shell 命令。普通 Pi CLI 不受此私有模式影响。
- `open()` 核对稳定的原生 session ID；优先使用确切会话文件，未保存路径时在独立会话目录按 ID 查找。文件实际存在后才返回持久恢复路径。模型选择以当前私有配置为准，不从旧历史恢复。
- `sendInput()` 使用 `prompt(text, undefined, 'steer')`，返回输入 ID 与 `started`／`queued`／`handled` 回执。已知的压缩拒绝可重试，缺模型／认证拒绝需修改配置；其他错误保守地视为未知结果。
- `onEvent()` 只返回可展示的文本、工具名称与阶段、队列数量、活动、状态和错误，不暴露原始 response、模型 headers 或工具参数。迟到的原生 response 不参与输入状态更新。
- `getState()` 验证身份并返回精简状态；打开后每 10 秒自动检查，同一实例最多一个在途检查，关闭后不再发布结果。探活失败转为公共 `fatal` 错误事件，adaptor 无需解释 Pi 的阶段名称。
- `recoverInputs(inputs)` 使用 Pi 原生历史解析器读取已写入文件的 user 文本，在 Pi 内部匹配完整输入，仅向 adaptor 返回确切确认的输入 ID，可在关闭后调用。未找到或扩展改写的输入不宣称未执行，需要保留待恢复；不重建模型上下文。
- `close()` 停止检查，给 abort 最多 3 秒，再调用原客户端 stop（SIGTERM，约 1 秒后可 SIGKILL）。历史与绑定由 adaptor 保留。

`readModelSelection()`／`writeModelSelection()` 读取或保存模型选择；`readModelOptions()` 只提供可公开的模型候选、接口与认证存在状态，`saveModelConfiguration()` 保存表单中的选择、接口和 API Key。API Key 按字面值转义后只保存在 `auth.json`，不创建宿主环境引用；留空保留、显式清除删除旧认证及 `models.json` 的旧 Key。保留其他 Provider 和现有模型参数；配置损坏时拒绝覆盖，多文件写入失败回滚，未完成保存标记会阻止 Pi 启动。`PiSettings` 只携带私有目录和扩展路径，不重复携带 provider/model。

`readSystemPrompt()` 读取本实例 `pi-config/SYSTEM.md`，不存在时返回 `{mode:"default",text:""}`，存在时返回 `{mode:"replace",text}`。`saveModelConfiguration()` 可接收 `system_prompt`：替换模式原样保存 UTF-8 正文（非空、最多 64 KiB，文件权限 `0600`），默认模式移除该文件；不传此字段则保留。仅保存提示词不会重写模型和认证文件，提示词写入／删除参与多文件保存回滚。

私有配置模式只从本实例 `SYSTEM.md` 读取替换提示词，不加载工作目录 `.pi/SYSTEM.md`、任何 `APPEND_SYSTEM.md` 或 CLI 提示词参数。替换遵循 Pi 原生语义：替换默认提示词主体，项目指令、Skills 和工作目录信息仍会加入，工具能力不变；普通 Pi CLI 的发现规则不变。重新打开同一会话后使用最新配置，保留历史。

`OpenConfig.mcpServers` 可接收 `McpConnection[]`，每项只有 `{name,url,headers?}`。pi-adaptor 在 `open()` 中、启动 RPC 前将托管项写入本实例 `pi-config/mcp.json`，使用 HTTP transport、`enabled: true` 和 `exposure: direct`，因此 Pi 原生 MCP 客户端会直接向模型提供工具。配置目录为 `0700`，文件为 `0600`，原子替换并保留其他 MCP 项；重启时更新托管配置。配置损坏、符号链接指向目录外、同名命名空间冲突或工作目录 `.pi/mcp.json` 覆盖托管项时抛出 `ConfigurationError`。

通用 IM 工具、登录和续期、MCP Server、访问凭据签发属于 adaptor。pi-adaptor 只处理 Pi 配置及 RPC，不查询 IM、读取 adaptor SQLite 或管理通用 MCP 服务生命周期。MCP 凭据由 adaptor 传入且独立于 IM Token，不写入 `PiSettings`、模型请求或对外运行状态。skill + CLI 接入方案已废弃；本期不实现 Codex／Claude Code 适配。

`npm test --workspace=@starrychat/pi-adaptor` 使用真实 RpcClient 和确定性的 JSONL 子进程测试生命周期、环境变量隔离、MCP 私有配置与异常边界。adaptor 后端测试使用真实 Pi 和本地模拟模型／IM，验证 MCP 工具发现、历史读取、引用和 @ 发送、会话恢复不重复发送；同时覆盖多 Agent 身份隔离、续期及未知发送结果。外部模型调用不包含在自动化测试中。
