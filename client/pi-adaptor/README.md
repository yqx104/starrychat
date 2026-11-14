# Pi adaptor

`@starrychat/pi-adaptor` 是 adaptor 后端引用的 TypeScript 库。每个 `PiSession` 封装仓库内 Pi 的原生 `RpcClient`，启动一个 Pi RPC 子进程；没有独立 HTTP 服务或自定义进程通信协议。

在项目根完成依赖安装及 Pi 模型目录准备后，执行 `npm run build:adaptor`。后端默认入口是 `agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js`；源码来源仍为本地 fork。Pi SDK 延迟到打开会话时加载，Pi 缺少构建或启动失败不会阻止 adaptor 收件。

导出 `PiSession`、`Session`、`OpenConfig`、`SessionEvent` 和 `InputError` 等类型。使用顺序是创建对象、订阅 `onEvent()`、调用 `open()`，随后调用 `sendInput({id,text})`、`getState()`、`abort()`，最后 `close()`。一个对象只能打开一次；关闭后恢复需按同一 `nativeRef` 创建新对象。

- `open()` 核对稳定的原生 session ID；优先使用确切会话文件，未保存路径时在独立会话目录按 ID 查找。文件实际存在后才返回持久恢复路径。
- `sendInput()` 使用 `prompt(text, undefined, 'steer')`，返回输入 ID 与 `started`／`queued`／`handled` 回执。已知的压缩拒绝可重试，缺模型／认证拒绝需修改配置；其他错误保守地视为未知结果。
- `onEvent()` 只返回可展示的文本、工具名称与阶段、队列数量、活动、状态和错误，不暴露原始 response、模型 headers 或工具参数。迟到的原生 response 不参与输入状态更新。
- `getState()` 验证身份并返回精简状态；打开后每 10 秒自动检查，同一实例最多一个在途检查，关闭后不再发布结果。
- `persistedInputs()` 使用 Pi 原生历史解析器读取已经写入文件的 user 文本，仅供 adaptor 做输入核对，不重建模型上下文。扩展改写的内容可能无法关联，需要人工核对。
- `close()` 停止检查，给 abort 最多 3 秒，再调用原客户端 stop（SIGTERM，约 1 秒后可 SIGKILL）。历史与绑定由 adaptor 保留。

`npm test --workspace=@starrychat/pi-adaptor` 使用真实 RpcClient 和确定性的 JSONL 子进程测试生命周期与异常边界。真实 Pi、工具和本地模型协议的链路验证在 adaptor 后端测试中。外部模型调用不包含在自动化测试中。
