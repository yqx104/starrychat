# Pi 本地精简 fork

本目录已实际纳入默认 Pi Agent 所需源码及构建配套，由 starrychat 独立维护。保留来源和许可证用于追溯，不配置自动拉取、定期同步或自动替换为上游/npm 新版本的机制。

## 来源

- 上游：[earendil-works/pi](https://github.com/earendil-works/pi)。
- 复制来源：`/Users/yqx/Desktop/pi-agent`；该目录仅用于本次导入，不是运行依赖或符号链接。
- 固定提交：[6e2222a8dda06e3d69fad46d630f152f5873567a](https://github.com/earendil-works/pi/commit/6e2222a8dda06e3d69fad46d630f152f5873567a)。
- 导入日期：2026-11-08。
- 上游包版本字段：`1.5.0`；实际快照为 `v1.5.0-305-g6e2222a8`，不等同于 npm 发布版。
- 许可：[上游 MIT LICENSE](LICENSE)。包内原有版权注释和 `THIRD_PARTY_NOTICES` 已保留。

## 已纳入的包

所有包保留 `@earendil-works/` 名称和原有相对层级。

| 包 | 本地目录 | 内部运行依赖 |
| --- | --- | --- |
| pi-ai | [packages/ai](packages/ai/README.md) | pi-schema、pi-telemetry |
| pi-agent-core | [packages/agent](packages/agent/README.md) | pi-ai、pi-schema |
| pi-coding-agent | [packages/coding-agent](packages/coding-agent/README.md) | pi-agent-core、pi-ai、pi-tui、pi-mcp、pi-codemode |
| pi-schema | [packages/schema](packages/schema/README.md) | 无 |
| pi-telemetry | [packages/telemetry](packages/telemetry/README.md) | 无 |
| pi-tui | [packages/tui](packages/tui/README.md) | 无 |
| pi-mcp | [packages/mcp](packages/mcp/README.md) | 无 |
| pi-codemode | [packages/codemode](packages/codemode/README.md) | 无 |

保留这八个包的受 Git 跟踪源码、目录生成器、资源、包元数据、文档、示例及原有测试；未运行完整测试套件，本次仅执行临时运行验证。不纳入 Chord、Durable、Env 或其他上游应用/包。

根级配套包括 `tsconfig.base.json`、限定范围后的 `tsconfig.json`、`vitest.base.ts`，以及 `scripts/package-files.mjs`、`scripts/build-coding-agent-bundle.mjs`、原有测试引用的 `scripts/model-catalog-protocol.ts`。

## 本地配置调整

- 项目根注册八个包及 `@starrychat/pi-upstream` 构建 workspace。三个核心包之间及其内部依赖直接使用 `file:../<包目录>`，默认 Agent 使用 `file:./upstream/packages/<包目录>`；安装后八个包均已核对链接到本地目录。npm 的 [workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) 负责本地包链接。
- 首次安装发现 Pi 包的 `file:` overrides 与 npm 11.12.1 的 workspace 直接依赖规格冲突，报 `EOVERRIDE`。已删除项目根和构建根的这组覆盖，将九条包间依赖改为上述相对路径；保留 `protobufjs` 的原有覆盖。外部依赖版本和运行源码未修改。
- 安装根显式声明 schema 原有的测试依赖 `ata-validator@1.61.3`。本机 npm 将它记录在嵌套 workspace 下却未安装；放到安装根后，按锁文件重新安装及 `npm ls --workspaces --depth=0` 均通过。本次不执行该工具或其测试。
- 此处 `package.json` 只保留八包构建顺序、模型目录生成及可选原生构建命令和所需工具版本，不导入上游的发布、版本更新或安装钩子。
- TypeScript 和 Vitest 配置只保留已纳入包的引用，移除未纳入包、失效 hooks 路径以及原仓库固定 `node_modules` 路径别名。
- coding-agent 的 `package.json` 移除依赖原仓库布局的独立 Bun 二进制打包命令，并调整内部包依赖路径；保留 Node SDK/CLI 构建及运行元数据。包内运行源码未修改。

逐文件上游/本地 SHA-256、七处上游配置调整及排除文件见 [UPSTREAM-MANIFEST.json](UPSTREAM-MANIFEST.json)。

## 本地运行

以下命令在项目根目录执行。当前依赖、模型目录数据和构建产物已保留，可直接验证本地 CLI：

```sh
node agents/pi/upstream/packages/coding-agent/dist/bundle/cli.js --version
```

SDK 入口为 `agents/pi/upstream/packages/coding-agent/dist/index.js`；本项目内也可导入 `@earendil-works/pi-coding-agent`，它链接到此本地包。

已有模型目录数据时，重新构建使用：

```sh
npm run build:offline --workspace @starrychat/pi-upstream
```

需要重新准备环境时，按根目录的 `package-lock.json` 安装，并显式生成缺失的模型元数据。安装禁用依赖生命周期脚本，构建命令单独运行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run hydrate:model-data --workspace @starrychat/pi-upstream
npm run build:offline --workspace @starrychat/pi-upstream
```

`hydrate:model-data` 读取公开模型目录，不发送对话请求，只写生成的 JSON 数据，不改已纳入的运行源码。

## 已验证范围

2026-11-08，在 Node `v24.15.0`、npm `11.12.1` 上完成：

- 安装外部依赖并生成根锁文件；再用 `npm ci --ignore-scripts` 完整重装并通过依赖树检查，八个 Pi 包均解析到本地 workspace。
- 生成并校验模型目录数据，八包构建成功，包括 Coding Agent CLI bundle 和工作线程产物。
- 直接执行本地 bundle，`--version` 输出 `1.5.0`，退出码为 0。
- 从本地编译出的 SDK 创建真实 `AgentSession`：初始消息为空、无持久化会话文件、状态空闲，默认 `read`、`bash`、`edit`、`write` 四个工具已注册。
- 内置目录加载到 1627 个聊天模型；选用 `anthropic/claude-haiku-4-5`，向会话提交 `Hello`。真实认证检查在 `AgentSession._preparePrompt` 返回 `No API key found for anthropic.`，会话仍空闲、没有排队消息，`abort()` 和 `dispose()` 均完成，验证进程正常退出。

验证使用独立临时工作/配置目录、空的内存认证和设置存储、内存会话，且不发现个人扩展、技能或上下文文件。子进程不继承模型凭据；网络保护检查记录请求次数为 0。没有注入模拟 provider 或伪造模型错误。临时脚本和配置已清理。

本次验证了模型请求前的认证失败通路，没有发出真实模型请求；模型服务可达性、成功生成和收费调用均未验证。未启动协作项目服务，未运行完整测试套件、原生平台构建或独立可执行文件发布。

导入时未复制 `.git`、依赖、缓存、会话、凭据、环境文件或构建产物；本次依赖与构建产物均在本项目内生成。原生 `.node` 预编译文件和 Doom 示例编译产物仍未准备，不属于此次验证范围。

这份源码只属于 [默认 Pi Agent](../README.md)。IM、Trigger 和未来外部 Agent 不需要依赖这些包；统一 IM CLI 和各 harness 的唤起适配均尚未实现。
