#!/bin/sh
# 运行后台和测试。维护者本机有网络锁启动器 safe-node.sh（不在开源仓库里）时走它，
# 其他人的电脑上直接用 node。
set -eu
dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
if [ -x "$dir/safe-node.sh" ]; then exec "$dir/safe-node.sh" "$@"; fi
exec node "$@"
