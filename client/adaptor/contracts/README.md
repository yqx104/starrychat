# Adaptor 公共接口

`@starrychat/adaptor-contracts` 只定义 adaptor 与运行器之间的接口和公共错误，不依赖 Pi、IM、数据库或进程实现。

- `Harness` 读取、校验和保存运行器配置，检查既有目录与会话引用，并创建 `Session`。具体文件格式、认证、默认可执行路径和原生会话 ID 由对应运行器管理。
- `Session` 提供打开、输入、状态、事件、中止和关闭；`nativeRef` 是运行器拥有的可 JSON 序列化引用，adaptor 只保存和回传。创建对象后、打开进程前先保存引用，避免异常退出后丢失会话身份。
- `recoverInputs(inputs)` 可在关闭后调用，只返回能够确认已持久化的输入 ID。缺失的 ID 或核对失败均表示未知，公共层保留为待恢复，不自动重发。`started`／`queued` 表示接收而非完成；`handled` 表示输入已被处理且无需模型历史核对。
- `SessionEvent.fatal` 表示实例已不可继续派发；adaptor 不解释原生 RPC 阶段。显示事件和状态只能包含可公开信息。
- `McpConnection` 只描述服务名、URL 和可选 headers。IM MCP 的工具与凭据属于 adaptor，运行器负责自身的 MCP 接入方式；凭据不能进入配置响应、运行状态或模型输入。

adaptor 的 `clients/harnesses.ts` 用静态列表注册驱动，第一个为未配置 Agent 的默认运行器；当前只注册 Pi。配置读写返回的附加元数据由对应前端表单消费，不引入动态插件或表单框架。公共层负责配置修改时机、Agent 目录、队列、启停和恢复状态；配置与原生引用的字段由驱动解释。已有会话不能直接更换运行器，避免把一种历史交给另一种运行器。

本次不改 SQLite 结构或现有 Pi 目录。后续 Codex、CC 适配实现该接口并在注册入口加入即可；具体接入尚未实现。
