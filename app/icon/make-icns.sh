#!/bin/bash
# Rebuilds app/AppIcon.icns from the flame drawn by make-icon.swift.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

swift "$DIR/make-icon.swift" "$DIR/AppIcon-1024.png" >/dev/null
SET="$WORK/AppIcon.iconset"
mkdir -p "$SET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$DIR/AppIcon-1024.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$DIR/AppIcon-1024.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$DIR/../AppIcon.icns"
echo "✓ $(cd "$DIR/.." && pwd)/AppIcon.icns"
