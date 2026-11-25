# 参与 Fire Ring

谢谢你愿意一起改进 Fire Ring！Bug 反馈、新功能想法、接入新的 AI 工具、改文案，都欢迎。

## 提 Issue

- **Bug**：写清楚 macOS 版本、Fire Ring 版本（设置 → 通用）、用的是哪个工具，以及怎么复现。可以附上「设置 → 通用 → 导出诊断信息」生成的文件，里面已经去掉了对话内容和 Key。
- **新功能**：先说说你想解决什么问题，大一点的改动最好先开 Issue 聊一下方向，再动手写。

## 提 PR

1. Fork 本仓库，从 `main` 新建一个分支。
2. 按 [开发说明](docs/DEVELOPMENT.md) 在本机构建、运行。
3. 改完跑一遍测试：`cd bridge && npm test`，全部通过再提交。
4. 提 PR 时按模板写清楚改了什么、为什么、怎么验证的。改了界面请附截图（深色、浅色各一张更好）。

维护者会审阅每个 PR，可能会请你调整；合并后你的名字会出现在提交记录和贡献者列表里。

## 几条原则

这些是 Fire Ring 一直遵守的，PR 也请保持：

- **隐私**：任务状态只在本机读取，不上传、不写进日志任何对话内容、Key、令牌或 Cookie。
- **网络**：所有对外请求都经过 `bridge/src/egress.mjs`，遵守用户在「设置 → 网络」里选的线路；连不上就停下报错，不偷偷换线路或直连。新增联网功能请先在 Issue 里说明。
- **不借用登录**：不拿用户在其他软件里的登录凭据去调用没有公开的接口。接入新工具优先用官方提供的方式：本机记录、钩子（hooks）、插件。
- **不打扰**：默认安静，新提醒、新弹窗默认关闭或可以关掉。
- **界面文案**：用简体中文，简短、口语化；深色是默认外观，浅色跟随 Fire Design 风格。

## 接入新的 AI 工具

现在支持 Claude Code、Codex、DeepSeek Harness。很欢迎接入更多工具（比如 Cursor、Kimi Code、Grok、Antigravity），可以参考已有的接法：

- 读本机记录：`bridge/src/providers.mjs`（Claude Code、Codex）
- 插件：`integrations/deepseek-harness/`（DeepSeek Harness）
- 钩子（hooks）：Cursor、Kimi Code、Antigravity 等都支持在任务开始、结束时运行一条命令，很适合用来上报状态。

刘海里每条任务前的小 logo 在 `app/logos/`，Cursor、Kimi、Grok 的已经放好了，接入时在 `app/index.html` 的 `LOGOS` 里加上即可。

请同时补上测试（`bridge/test/`），并在设置的「连接」里给出连接、断开的说明。连接时改动了用户的配置文件，断开时要能原样恢复。

## 许可

提交 PR 即表示你同意按本仓库的 [MIT 许可](LICENSE) 提供你的贡献。
