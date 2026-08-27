#!/bin/bash
# アドホック署名（Apple Developer Program $99/年 を使わない署名）。
# 内側（.appex）→ 外側（.app）の順で署名しないと外側の署名が壊れる。
#
# ⚠ この署名で PluginKit が拡張を登録してくれるかどうかが、この実験の争点そのもの。
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-build/Build/Products/Release/PAC for Final Cut.app}"
APPEX="$APP/Contents/PlugIns/WorkflowExtension.appex"

[ -d "$APP" ]   || { echo "❌ .app がない: $APP"; exit 1; }
[ -d "$APPEX" ] || { echo "❌ .appex が同梱されていない: $APPEX"; exit 1; }

# 同梱した実行ファイルとライブラリ（エンジン・ffmpeg）を先に署名する。
# 中に署名されていない Mach-O があると、外側の署名が通らない。
ENGINE="$APP/Contents/Resources/engine"
FFMPEG="$APP/Contents/Resources/ffmpeg/ffmpeg"
if [ -d "$ENGINE" ] || [ -f "$FFMPEG" ]; then
  echo "--- 署名: 同梱の実行ファイル ---"
  # 🔴 エンジンには署名なしの .so/.dylib が数百個入っている。
  #    ここを飛ばすと「アプリは起動するが解析だけ動かない」形で壊れる。
  find "$APP/Contents/Resources" \( -name "*.dylib" -o -name "*.so" -o -perm +111 -type f \) -print0 2>/dev/null     | xargs -0 -n 20 codesign --force --sign - --timestamp=none 2>/dev/null || true
  echo "  署名した数: $(find "$APP/Contents/Resources" -type f \( -name "*.dylib" -o -name "*.so" -o -perm +111 \) 2>/dev/null | wc -l | tr -d ' ')"
fi

echo "--- 署名: WorkflowExtension.appex ---"
codesign --force --sign - \
  --options runtime \
  --entitlements Extension/WorkflowExtension.entitlements \
  --timestamp=none \
  "$APPEX"

echo "--- 署名: PAC for Final Cut.app ---"
codesign --force --sign - \
  --options runtime \
  --entitlements App/PAC.entitlements \
  --timestamp=none \
  "$APP"

echo "--- 確認 ---"
codesign --verify --strict --verbose=2 "$APPEX"
codesign --verify --strict --verbose=2 "$APP"
echo "✅ アドホック署名 完了"
