# Pi adaptor

`@starrychat/pi-adaptor` 是 adaptor 后端引用的 TypeScript 库。每个 `PiSession` 封装仓库内 Pi 的原生 `RpcClient`，启动一个 Pi RPC 子进程；没有独立 HTTP 服务或自定义进程通信协议。

在项目根完成依赖安装及 Pi 模型目录准备后，执行 `npm run build:adaptor`。后端默认入口是 `agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js`；源码来源仍为本地 fork。Pi SDK 延迟到打开会话时加载，Pi 缺少构建或启动失败不会阻止 adaptor 收件。

导出 `PiSession`、`Session`、`OpenConfig`、`SessionEvent` 和 `InputError` 等类型。使用顺序是创建对象、订阅 `onEvent()`、调用 `open()`，随后调用 `sendInput({id,text})`、`getState()`、`abort()`，最后 `close()`。一个对象只能打开一次；关闭后恢复需按同一 `nativeRef` 创建新对象。

- `open()` 先读取实例 `pi-config/settings.json` 的 `defaultProvider`、`defaultModel`，检查私有配置 JSON；使用环境变量白名单启动 RPC，再检查指定模型及认证是否可用。缺少配置抛出 `ConfigurationError`，检查失败会关闭进程。凭据来自实例 `auth.json`／`models.json`，不继承宿主机密钥、云认证链或工作目录模型设置；禁用凭据 shell 命令。普通 Pi CLI 不受此私有模式影响。
- `open()` 核对稳定的原生 session ID；优先使用确切会话文件，未保存路径时在独立会话目录按 ID 查找。文件实际存在后才返回持久恢复路径。模型选择以当前私有配置为准，不从旧历史恢复。
- `sendInput()` 使用 `prompt(text, undefined, 'steer')`，返回输入 ID 与 `started`／`queued`／`handled` 回执。已知的压缩拒绝可重试，缺模型／认证拒绝需修改配置；其他错误保守地视为未知结果。
- `onEvent()` 只返回可展示的文本、工具名称与阶段、队列数量、活动、状态和错误，不暴露原始 response、模型 headers 或工具参数。迟到的原生 response 不参与输入状态更新。
- `getState()` 验证身份并返回精简状态；打开后每 10 秒自动检查，同一实例最多一个在途检查，关闭后不再发布结果。
- `persistedInputs()` 使用 Pi 原生历史解析器读取已经写入文件的 user 文本，仅供 adaptor 做输入核对，不重建模型上下文。扩展改写的内容可能无法关联，需要人工核对。
- `close()` 停止检查，给 abort 最多 3 秒，再调用原客户端 stop（SIGTERM，约 1 秒后可 SIGKILL）。历史与绑定由 adaptor 保留。

`readModelSelection()`／`writeModelSelection()` 读取或保存模型选择；`readModelOptions()` 只提供可公开的模型候选、接口与认证存在状态，`saveModelConfiguration()` 保存表单中的选择、接口和 API Key。API Key 按字面值转义后只保存在 `auth.json`，不创建宿主环境引用；留空保留、显式清除删除旧认证及 `models.json` 的旧 Key。保留其他 Provider 和现有模型参数；配置损坏时拒绝覆盖，多文件写入失败回滚，未完成保存标记会阻止 Pi 启动。`PiSettings` 只携带私有目录和扩展路径，不重复携带 provider/model。

`readSystemPrompt()` 读取本实例 `pi-config/SYSTEM.md`，不存在时返回 `{mode:"default",text:""}`，存在时返回 `{mode:"replace",text}`。`saveModelConfiguration()` 可接收 `system_prompt`：替换模式原样保存 UTF-8 正文（非空、最多 64 KiB，文件权限 `0600`），默认模式移除该文件；不传此字段则保留。仅保存提示词不会重写模型和认证文件，提示词写入／删除参与多文件保存回滚。

私有配置模式只从本实例 `SYSTEM.md` 读取替换提示词，不加载工作目录 `.pi/SYSTEM.md`、任何 `APPEND_SYSTEM.md` 或 CLI 提示词参数。替换遵循 Pi 原生语义：替换默认提示词主体，项目指令、Skills 和工作目录信息仍会加入，工具能力不变；普通 Pi CLI 的发现规则不变。重新打开同一会话后使用最新配置，保留历史。

`npm test --workspace=@starrychat/pi-adaptor` 使用真实 RpcClient 和确定性的 JSONL 子进程测试生命周期、环境变量隔离与异常边界。真实 Pi、工具、本地模型协议、两个实例独立认证和系统提示词的链路验证在 adaptor 后端测试中。外部模型调用不包含在自动化测试中。
