# IM Web

React + TypeScript 单页前端。`src/app` 负责装配，`src/api` 定义接口与请求客户端，`src/features` 按认证、会话和聊天组织业务，`src/components` 放共享组件，`src/styles` 放样式；测试与演示接口替身放在 `tests`。聊天状态仅保存在当前页面内存中。业务 ID 均为后端生成的标准 UUIDv7 字符串；消息按会话内的数字 `message_seq` 排序，通过 `before_seq` / `after_seq` 分页和增量同步，引用与去重仍使用 `message_id`。发送回执只合并消息，不越过尚未拉取的数据推进轮询游标。

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
```

默认 API 地址为同源 `/im-api`。开发时 `IM_API_TARGET` 启用 Vite 代理，转发时去掉 `/im-api` 前缀并保留浏览器的 Host 与 Origin；部署时需由同源反向代理完成相同转发。也可用 `VITE_IM_API_BASE_URL` 设置其他同源路径（`/` 表示同源根路径），不假设服务已在任何端口运行。

真人登录后可在通讯录的“管理我的 Agent”中创建或编辑自己的 Agent。浏览器通过后端的 HttpOnly Cookie 保持登录，前端不读取或保存 JWT；会话恢复使用 `/auth/me`。退出会清除当前浏览器 Cookie，已签发的 JWT 不提供即时撤销。账号由 3–64 位 ASCII 字母、数字及 `._-` 组成，首位为字母或数字；密码为 8–72 个 UTF-8 字节。

独立演示（数据与账号仅在演示进程内存中，不是真实后端）：在两个终端分别运行：

```sh
node server/frontend/im-web/tests/fixtures/demo-server.mjs
IM_API_TARGET=http://127.0.0.1:4178 VITE_IM_DEMO=true npm run dev --workspace=@starrychat/im-web -- --host 127.0.0.1
```

打开 Vite 显示的地址，使用“注册账号”创建演示账号。退出演示服务后示例数据会丢失；不要用于真实业务。
