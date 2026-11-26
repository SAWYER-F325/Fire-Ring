#!/bin/bash
# Builds build/FireRing.app: the Swift app, plus its own copy of Node and the
# bridge, so the person installing it needs nothing else.
#
#   app/build.sh                    build for this Mac's chip
#   ARCH=x86_64 NODE_BIN=/path/to/x64/node app/build.sh
#   FIRE_RING_REPO=owner/name app/build.sh   where updates are looked up
#   FIRE_RING_LOCAL_LOCK=1 app/build.sh       载入本机自己的网络锁 app/local/lock.sh
#                                            （不在开源仓库里，没有就停止打包）。
#                                            普通构建不带锁，每位用户在「设置 → 网络」里自己选线路。
#
# Needs: Xcode or the Command Line Tools (swiftc), and Node 22.5 or later for
# the target chip (taken from NODE_BIN, else the `node` on PATH).
set -euo pipefail

APP_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$APP_DIR/.." && pwd)
BUILD="$ROOT/build"
APP="$BUILD/FireRing.app"
ARCH=${ARCH:-$(uname -m)}
VERSION=$(tr -d '[:space:]' < "$ROOT/VERSION")
BUILD_NUMBER=${BUILD_NUMBER:-$(date +%Y%m%d%H%M)}

fail() { echo "✗ $*" >&2; exit 1; }

case "$ARCH" in arm64|x86_64) ;; *) fail "不支持的芯片架构：$ARCH" ;; esac

# Where "检查更新" looks: FIRE_RING_REPO, else this checkout's GitHub remote.
REPO=${FIRE_RING_REPO:-}
if [ -z "$REPO" ] && git -C "$ROOT" rev-parse >/dev/null 2>&1; then
  REMOTE=$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)
  REPO=$(printf '%s' "$REMOTE" | sed -nE 's#^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)$#\2#p' | sed -E 's/\.git$//')
fi
[ -n "$REPO" ] || echo "! 没有设置发布仓库（FIRE_RING_REPO 或 git remote），这个版本里「检查更新」会提示未配置"

# Node for the target chip.
NODE=${NODE_BIN:-$(command -v node || true)}
[ -n "$NODE" ] && [ -x "$NODE" ] || fail "找不到 Node。请安装 Node 22.5 以上，或用 NODE_BIN 指定"
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")
NODE_VERSION=$("$NODE" -p 'process.versions.node' 2>/dev/null || true)
if [ -n "$NODE_VERSION" ]; then
  "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
    || fail "Node 版本太旧（$NODE_VERSION），需要 22.5 以上"
fi
file "$NODE" | grep -q "$ARCH" || fail "$NODE 不是 $ARCH 版本的 Node"

# Swift: prefer the active developer SDK, then the Command Line Tools ones.
SDKS=()
SDK_PATH=$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)
[ -n "$SDK_PATH" ] && SDKS+=("$SDK_PATH")
for sdk in /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk; do [ -d "$sdk" ] && SDKS+=("$sdk"); done
[ ${#SDKS[@]} -gt 0 ] || fail "找不到 macOS SDK。请先运行 xcode-select --install"
SWIFTC=$(xcrun --find swiftc 2>/dev/null || command -v swiftc || true)
[ -n "$SWIFTC" ] || fail "找不到 swiftc。请先运行 xcode-select --install"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD/modulecache"

built=""
for sdk in "${SDKS[@]}"; do
  if "$SWIFTC" -O -suppress-warnings \
      -sdk "$sdk" \
      -module-cache-path "$BUILD/modulecache" \
      -target "$ARCH-apple-macos14.0" \
      -o "$APP/Contents/MacOS/FireRing" \
      "$APP_DIR/main.swift" "$APP_DIR/Bridge.swift" "$APP_DIR/Preferences.swift" "$APP_DIR/Glass.swift" "$APP_DIR/Welcome.swift" "$APP_DIR/Alerts.swift" \
      -framework AppKit -framework Carbon -framework WebKit -framework ServiceManagement -framework UserNotifications 2>"$BUILD/swiftc.log"; then
    built="$sdk"; break
  fi
  rm -rf "$BUILD/modulecache"; mkdir -p "$BUILD/modulecache"
done
[ -n "$built" ] || { tail -20 "$BUILD/swiftc.log" >&2; fail "编译失败，详见 build/swiftc.log"; }

RES="$APP/Contents/Resources"
sed -e "s#__VERSION__#$VERSION#" -e "s#__BUILD__#$BUILD_NUMBER#" -e "s#__REPO__#$REPO#" \
  "$APP_DIR/Info.plist" > "$APP/Contents/Info.plist"
cp "$APP_DIR/index.html" "$APP_DIR/panel.html" "$APP_DIR/settings.html" "$APP_DIR/welcome.html" "$RES/"
cp -R "$APP_DIR/brand" "$RES/brand"
cp -R "$APP_DIR/fonts" "$RES/fonts"
cp -R "$APP_DIR/logos" "$RES/logos"
cp -R "$APP_DIR/sounds" "$RES/sounds"
cp "$APP_DIR/AppIcon.icns" "$RES/AppIcon.icns"

mkdir -p "$RES/runtime" "$RES/bridge" "$RES/integrations"
if [ "${FIRE_RING_LOCAL_LOCK:-}" = "1" ]; then
  # 本机自己的网络锁：放在 app/local/lock.sh，只在本机，不进开源仓库。
  [ -r "$APP_DIR/local/lock.sh" ] || { echo "✗ 要求加网络锁，但没有 app/local/lock.sh，停止打包" >&2; exit 1; }
  . "$APP_DIR/local/lock.sh"
else
  cp "$NODE" "$RES/runtime/node"
  chmod 755 "$RES/runtime/node"
  LOCK_NOTE="网络由用户自行设置"
fi
NODE_LICENSE="$(dirname "$(dirname "$NODE")")/LICENSE"
[ -f "$NODE_LICENSE" ] && cp "$NODE_LICENSE" "$RES/runtime/LICENSE"
cp -R "$ROOT/bridge/src" "$RES/bridge/src"
cp "$ROOT/bridge/package.json" "$RES/bridge/package.json"
cp -R "$ROOT/integrations/deepseek-harness" "$RES/integrations/deepseek-harness"
cp "$ROOT/LICENSES.md" "$RES/LICENSES.md" 2>/dev/null || true
printf 'APPL????' > "$APP/Contents/PkgInfo"
xattr -cr "$APP"

# An ad-hoc signature: enough for macOS to run it on this Mac and keep its
# settings; people downloading it confirm the first open once.
codesign --force --sign - --identifier dev.firering.app "$APP" >/dev/null
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

echo "✓ $APP"
echo "  版本 $VERSION（$BUILD_NUMBER） · $ARCH · Node ${NODE_VERSION:-?} · SDK $(basename "$built") · 更新仓库 ${REPO:-未设置} · $LOCK_NOTE"
