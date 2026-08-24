#!/bin/bash
# アドホック署名（Apple Developer Program $99/年 を使わない署名）。
# 内側（.appex）→ 外側（.app）の順で署名しないと外側の署名が壊れる。
#
# ⚠ この署名で PluginKit が拡張を登録してくれるかどうかが、この実験の争点そのもの。
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-build/Build/Products/Release/PAC.app}"
APPEX="$APP/Contents/PlugIns/WorkflowExtension.appex"

[ -d "$APP" ]   || { echo "❌ .app がない: $APP"; exit 1; }
[ -d "$APPEX" ] || { echo "❌ .appex が同梱されていない: $APPEX"; exit 1; }

echo "--- 署名: WorkflowExtension.appex ---"
codesign --force --sign - \
  --options runtime \
  --entitlements Extension/WorkflowExtension.entitlements \
  --timestamp=none \
  "$APPEX"

echo "--- 署名: PAC.app ---"
codesign --force --sign - \
  --options runtime \
  --entitlements App/PAC.entitlements \
  --timestamp=none \
  "$APP"

echo "--- 確認 ---"
codesign --verify --strict --verbose=2 "$APPEX"
codesign --verify --strict --verbose=2 "$APP"
echo "✅ アドホック署名 完了"
