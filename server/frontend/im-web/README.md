# IM Web

本目录的 `tsconfig.json`、`biome.json` 和 `package.json` 分别维护 IM 前端的类型检查、格式与 Lint 规则、工具依赖及检查命令，可按 IM 的需求独立调整。

React + TypeScript 单页前端。`src/app` 负责装配，`src/api` 定义接口与请求客户端，`src/features` 按认证、Agent 管理、会话和聊天组织业务，`src/components` 放共享组件，`src/styles` 放样式；测试与演示接口替身放在 `tests`。选中聊天、搜索和草稿等临时界面状态仅保存在当前页面内存中。业务 ID 均为后端生成的标准 UUIDv7 字符串；消息按会话内的数字 `message_seq` 排序，通过 `before_seq` / `after_seq` 分页和增量同步，引用与去重仍使用 `message_id`。发送回执只合并消息，不越过尚未拉取的数据推进轮询游标。

左侧提供「消息」「通讯录」「群聊」三个入口。前端保留 `GET /conversations` 返回的完整会话列表，「消息」只显示 `hidden=false` 的会话，「群聊」展示全部群，包括已从消息列表移除的群。消息列表每项的关闭按钮调用 visibility 接口，将当前成员的 `hidden` 保存为 `true`；刷新页面后仍保持隐藏。

从通讯录点击 Agent 会打开并恢复原单聊，从群聊列表点击群会恢复原群聊并切回消息页，历史消息保留。移除聊天不退群、不解散，也不影响 Trigger 投递；新消息暂不自动恢复显示。列表显示状态保存在后端，当前选中聊天、搜索和草稿仍保存在页面内存中。

在仓库根目录运行：

```sh
npm install
./localdeploy/start.sh
./localdeploy/im-web/status.sh
./localdeploy/stop.sh
```

统一入口先启动 IM 后端，再启动前端；停止时顺序相反，MySQL 保持独立运行。前端地址为 `http://127.0.0.1:5173/`，脚本从 `localdeploy/im/config.json` 中只读取后端监听地址，自动设置 `/im-api` 代理并关闭演示模式。端口占用会明确失败，不会自动换端口。

前端也可单独使用 `localdeploy/im-web/start.sh`、`stop.sh`、`status.sh`；启动时需要后端已就绪。PID 保存在 `localdeploy/im-web/im-web.pid`，日志写入 `locallog/im-web/im-web.log`，正常停止会移除 PID。两个根目录均被 Git 忽略，本机脚本不随仓库分发。

手动开发及检查命令：

```sh
IM_API_TARGET=http://127.0.0.1:4180 npm run dev --workspace=@starrychat/im-web -- --host 127.0.0.1 --port 5173 --strictPort
npm run typecheck --workspace=@starrychat/im-web
npm run test --workspace=@starrychat/im-web
npm run build --workspace=@starrychat/im-web
npm run check --workspace=@starrychat/im-web
```

默认 API 地址为同源 `/im-api`。开发时 `IM_API_TARGET` 启用 Vite 代理，转发时去掉 `/im-api` 前缀并保留浏览器的 Host 与 Origin；部署时需由同源反向代理完成相同转发。也可用 `VITE_IM_API_BASE_URL` 设置其他同源路径（`/` 表示同源根路径），不假设服务已在任何端口运行。

注册页通过 `POST /auth/register` 提交 `username,password,name`，固定注册真人账号。真人登录后可在通讯录的“管理我的 Agent”中通过 `POST /agents` 创建自己的 Agent，也可编辑已有 Agent。创建时后端同时建立与该 Agent 的单聊；前端使用响应中的 `conversation` 立即更新消息列表，保留当前选中的聊天和草稿。浏览器通过后端的 HttpOnly Cookie 保持登录，前端不读取或保存 JWT；会话恢复使用 `/auth/me`。退出会清除当前浏览器 Cookie，已签发的 JWT 不提供即时撤销。账号由 3–64 位 ASCII 字母、数字及 `._-` 组成，首位为字母或数字；密码为 8–72 个 UTF-8 字节。

独立演示（数据与账号仅在演示进程内存中，不是真实后端）：在两个终端分别运行：

```sh
node server/frontend/im-web/tests/fixtures/demo-server.mjs
IM_API_TARGET=http://127.0.0.1:4178 VITE_IM_DEMO=true npm run dev --workspace=@starrychat/im-web -- --host 127.0.0.1
```

打开 Vite 显示的地址，使用“注册账号”创建演示账号。退出演示服务后示例数据会丢失；不要用于真实业务。

## 工程约定

功能专用的组件、Hook 和辅助函数放在对应的 `src/features` 目录；有实际复用需求时，再提取到本应用的 `src/components` 或 `src/lib`。认证和 Agent 管理共用的账号校验位于 `src/lib/account-validation.ts`，日期显示函数位于 `src/lib/format.ts`。接口层与公共组件不反向依赖业务组件，也不直接导入其他前端或后端的源码。

样式保留可读源码，由 `src/styles/index.css` 按固定顺序加载工作区、认证和 Agent 管理样式；调整组织方式时保留选择器、声明和加载顺序。

`npm run check --workspace=@starrychat/im-web` 依次执行格式检查、Lint、测试和生产构建，构建包含 TypeScript 类型检查。可分别运行 `format:check`、`lint`、`typecheck`、`test`、`build`；`format` 会修改本应用的源码格式。进入本目录后可直接执行这些 npm 命令。仓库根目录的 `check:frontend` 等批量命令会分别调用各前端自己的检查流程。

Biome 负责格式化和基础静态检查，`tsc` 负责类型检查。当前 Lint 覆盖未使用导入和变量、不可达代码、重复对象键、宽松相等、显式 `any`、列表 key、Hooks 调用位置和缺失依赖；保留用于重试、刷新和界面重置的显式 Effect 依赖。

测试使用 Vitest、Testing Library 和接口替身，不访问真实账号或数据库。修改请求与消息同步时，验证取消、过期响应、消息分页和错误重试；修改聊天界面时，保留草稿、引用、@ 提及及滚动行为。
