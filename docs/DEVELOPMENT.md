# 开发说明

## 目录

```
app/            Swift App：刘海（index.html）、菜单栏面板（panel.html）、设置窗口（settings.html）、欢迎页
  logos/        各工具的小 logo（版权归各自公司，见 LICENSES.md；Cursor、Kimi、Grok 的还没用上）
  sounds/       提示音
bridge/         后台服务（Node）：读取各工具的状态，在 127.0.0.1:47821 提供给 App
  src/          providers.mjs 读 Claude Code / Codex 记录，sessions.mjs 读 DeepSeek Harness，
                egress.mjs 是所有对外请求的唯一出口，status.mjs 决定「在跑 / 完成」
  test/         测试（node:test）
integrations/   DeepSeek Harness 插件
scripts/        发布脚本
release-notes/  每个版本的更新说明
VERSION         当前版本号
```

App 启动时用自带的 Node 运行 `bridge/src/main.mjs`，后台停了会自动重启，App 退出时一起退出。
数据在 `~/Library/Application Support/Fire Ring`，日志在 `~/Library/Logs/Fire Ring/bridge.log`。

## 环境

- macOS 14 或更新
- Xcode 或命令行工具（`xcode-select --install`）
- Node 22.5 或更新

## 测试

```bash
cd bridge
npm test
```

测试不需要联网，也不会读写你真实的 Fire Ring 数据。

## 构建和运行

```bash
app/build.sh            # 生成 build/FireRing.app
open build/FireRing.app
```

如果本机用 Homebrew 安装的 Node（动态链接 `libnode`），脚本会自动生成轻量启动器，避免复制出来的二进制缺少动态库；对外发布包建议用 `NODE_BIN` 指定官方独立版 Node。也支持通过 `SIGN_IDENTITY` 指定本机证书签名，或用 `FIRE_RING_REPO=none` 禁用自定义构建的更新检查。

如果你已经装了正式版 Fire Ring，先退出它，两个会抢同一个端口。

只想调后台、不想打包 App 时，可以单独运行，并把数据放到临时文件夹，避免影响正在用的 Fire Ring：

```bash
cd bridge
FIRE_RING_PORT=47999 FIRE_RING_DATA_DIR=/tmp/fire-ring-dev npm start
curl http://127.0.0.1:47999/state
```

## 界面

刘海、面板、设置都是 `app/` 里的 HTML 页面，改起来和网页一样；改完重新 `app/build.sh` 即可看到效果。改界面的 PR 请附截图。

## 发布（维护者）

改 `VERSION`，在 `release-notes/` 写好说明，然后运行 `scripts/release.sh` 生成安装包，在 GitHub Releases 发布。已安装的用户会在 6 小时内收到更新提示。

`app/build.sh` 还支持维护者在自己机器上加一层可选的网络锁（`FIRE_RING_LOCAL_LOCK=1`，配合本机的 `app/local/lock.sh`）。这不在仓库里，普通构建和发布版都不需要。
