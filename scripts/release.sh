#!/bin/bash
# Makes the files for one GitHub release, in dist/:
#   FireRing-<版本>-<芯片>.zip          给 App 内「一键更新」用
#   FireRing-<版本>-<芯片>.zip.sha256   它的校验值
#   FireRing-<版本>-<芯片>.dmg          给第一次下载的人用
#
# 用法：
#   1. 改 VERSION 里的版本号（例如 0.2.0）
#   2. scripts/release.sh
#   3. 在 GitHub 新建 Release，标签填 v0.2.0，把 dist/ 里这一版的文件全部拖进去，发布
#
# Intel 版：ARCH=x86_64 NODE_BIN=/path/to/node-x64/bin/node scripts/release.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARCH=${ARCH:-$(uname -m)}
VERSION=$(tr -d '[:space:]' < "$ROOT/VERSION")
DIST="$ROOT/dist"
NAME="FireRing-$VERSION-$ARCH"

echo "→ 运行测试"
NODE=${NODE_BIN:-$(command -v node)}
(cd "$ROOT/bridge" && npm run --silent test >/dev/null) || { echo "✗ 测试没通过，先修好再发布" >&2; exit 1; }

echo "→ 构建 App（发布版不带本机网络锁）"
FIRE_RING_LOCAL_LOCK= ARCH="$ARCH" "$ROOT/app/build.sh"
[ ! -e "$ROOT/build/FireRing.app/Contents/Resources/network.sb" ] || { echo "✗ 发布版里混进了本机网络锁，停止发布" >&2; exit 1; }
APP="$ROOT/build/FireRing.app"
REPO=$(/usr/bin/plutil -extract FireRingUpdateRepo raw "$APP/Contents/Info.plist" 2>/dev/null || true)
[ -n "$REPO" ] || echo "! 这个版本没有设置发布仓库，装了它的人收不到后续更新（设置 FIRE_RING_REPO=用户名/仓库名 后重新运行）"

mkdir -p "$DIST"
rm -f "$DIST/$NAME".zip "$DIST/$NAME".zip.sha256 "$DIST/$NAME".dmg

echo "→ 打包 zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$DIST/$NAME.zip"
(cd "$DIST" && /usr/bin/shasum -a 256 "$NAME.zip" > "$NAME.zip.sha256")

echo "→ 制作 dmg"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/Fire Ring.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/第一次打开请看这里.txt" <<'EOF'
安装：把「Fire Ring」拖进「Applications」（应用程序）文件夹。

第一次打开：
因为 Fire Ring 还没有苹果开发者签名，macOS 会提示「无法验证开发者」。
请打开「系统设置 → 隐私与安全性」，在页面下方找到 Fire Ring，点「仍要打开」。
只需要这样做一次，之后的更新会自动完成。
EOF
# hdiutil now and then fails right after a build (the new app is still being
# indexed); try a few times and show the real error if it keeps failing.
for attempt in 1 2 3; do
  if /usr/bin/hdiutil create -quiet -volname "Fire Ring $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DIST/$NAME.dmg" 2>"$STAGE.err"; then
    break
  fi
  [ "$attempt" = 3 ] && { echo "✗ 制作 dmg 失败：$(cat "$STAGE.err")" >&2; exit 1; }
  echo "  dmg 第 $attempt 次没做成，3 秒后重试"
  sleep 3
done
rm -f "$STAGE.err"

echo "✓ 发布文件已生成："
ls -lh "$DIST/$NAME".* | awk '{print "  " $5 "  " $NF}'
echo
echo "下一步：在 GitHub 新建 Release，标签 v$VERSION，上传上面三个文件。"
