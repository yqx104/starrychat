# Adaptor Web

React + TypeScript + Vite 本机管理界面。通过同源 `/adaptor-api` 访问 adaptor 后端。业务分为 Agent 接入与启停、收件箱、Pi 运行状态与配置；轮询和请求生命周期由对应业务 Hook 管理。

本目录的 `tsconfig.json`、`biome.json` 和 `package.json` 分别维护 adaptor 前端的类型检查、格式与 Lint 规则、工具依赖及检查命令，可按本机管理界面的需求独立调整。后端启动及业务说明见[Adaptor 文档](../README.md)。

在仓库根目录运行：

```sh
npm ci
ADAPTOR_API_TARGET=http://127.0.0.1:4183 npm run dev --workspace=@starrychat/adaptor-web
npm run check --workspace=@starrychat/adaptor-web
```

开发地址为 `http://127.0.0.1:5174`，端口被占用时直接失败。开发代理剥离 `/adaptor-api` 前缀并保留浏览器 Host；部署时需提供相同的同源反向代理。构建产物位于 `dist`。

`tests` 使用 Vitest、Testing Library 和 fetch 替身，覆盖账号接入及重新认证、启停、收件箱分页与取消请求、事件游标与 epoch 重置、执行中止、输入恢复确认、运行配置与凭据处理。

## 目录与工程约定

- `src/app`：页面装配、布局和跨模块协调。
- `src/features/agents`：账号接入、重新认证、连接状态和启停。
- `src/features/inbox`：收件箱显示、轮询与分页。
- `src/features/runtime`：主会话状态、执行事件、运行配置与输入恢复。
- `src/api`：HTTP 请求、具名接口函数和接口类型，组件不拼接 URL。
- `src/components`：本应用内复用的界面组件，不反向依赖业务模块。
- `src/styles`：基础样式、跨模块布局规则及统一样式入口。功能样式就近存放，由入口按固定顺序加载。
- `tests`：行为测试、初始化和接口替身，不访问真实账号、数据库和模型服务。

功能专用的组件、Hook 和辅助函数直接放在对应业务目录，按实际规模增加子目录。共享代码先限于本应用，不直接导入其他前端或后端的源码。`adaptor-contracts` 定义运行器接口，前端 HTTP 类型保留在 `src/api`。

## 检查流程

`npm run check --workspace=@starrychat/adaptor-web` 依次执行格式检查、Lint、测试和生产构建，构建包含 TypeScript 类型检查。可分别运行 `format:check`、`lint`、`typecheck`、`test`、`build`；`format` 会修改本应用的源码格式。进入本目录后可直接执行这些 npm 命令。仓库根目录的 `check:frontend` 等批量命令会分别调用各前端自己的检查流程。

Biome 负责格式化和基础静态检查，`tsc` 负责类型检查。当前 Lint 覆盖未使用导入和变量、不可达代码、重复对象键、宽松相等、显式 `any`、列表 key、Hooks 调用位置和缺失依赖；保留用于重试、刷新和界面重置的显式 Effect 依赖。

样式保留可读源码，调整组织方式时保留选择器、声明和加载顺序。修改轮询逻辑时验证请求取消、过期响应、分页及事件游标；修改表单时验证请求内容与凭据清理；恢复输入仍需明确确认。
