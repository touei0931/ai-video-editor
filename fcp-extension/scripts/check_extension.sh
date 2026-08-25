#!/bin/bash
# 配布前の関門。「ビルドが通った」ではなく「拡張として成立しているか」を見る。
# PAC で2度踏んだ「CI は通るのに友達の Mac で動かない」の再発防止。
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-build/Build/Products/Release/PAC.app}"
APPEX="$APP/Contents/PlugIns/WorkflowExtension.appex"
FAIL=0
ng() { echo "❌ $1"; FAIL=1; }
ok() { echo "✅ $1"; }

# 1. 拡張が .app の中に同梱されているか
[ -d "$APPEX" ] && ok "拡張が同梱されている" || ng "拡張が同梱されていない: $APPEX"
[ -f "$APPEX/Contents/MacOS/WorkflowExtension" ] \
  && ok "拡張の実行ファイルがある" || ng "拡張の実行ファイルがない"

# 2. 拡張ポイントが FCP のものか
PLIST="$APPEX/Contents/Info.plist"
POINT=$(/usr/libexec/PlistBuddy -c "Print :NSExtension:NSExtensionPointIdentifier" "$PLIST" 2>/dev/null || echo "")
[ "$POINT" = "com.apple.FinalCut.WorkflowExtension" ] \
  && ok "拡張ポイント: $POINT" || ng "拡張ポイントが違う: '$POINT'"

VC=$(/usr/libexec/PlistBuddy -c "Print :NSExtension:ProExtensionPrincipalViewControllerClass" "$PLIST" 2>/dev/null || echo "")
[ -n "$VC" ] && ok "主クラス: $VC" || ng "ProExtensionPrincipalViewControllerClass が無い"

# 3. UI が「配布した形で」同梱されているか
#    PAC で2度踏んだ「CI は通るのに中身が入っていない」を防ぐ関門
WEBUI="$APPEX/Contents/Resources/webui/index.html"
if [ -f "$WEBUI" ]; then
  ok "UI が同梱されている ($(ls "$APPEX/Contents/Resources/webui" | wc -l | tr -d ' ') ファイル)"
  grep -q "<div id=\"root\"></div>" "$WEBUI" && ok "index.html が React の入れ物になっている"     || ng "index.html の中身が想定と違う"
  test -d "$APPEX/Contents/Resources/webui/assets" && ok "JS/CSS が入っている" || ng "assets が無い"
else
  ng "UI が同梱されていない: $WEBUI"
fi

# 4. サンドボックス entitlement（無いと Gatekeeper が plug-ins must be sandboxed で弾く）
ENTS=$(codesign -d --entitlements :- "$APPEX" 2>/dev/null || echo "")
echo "$ENTS" | grep -q "com.apple.security.app-sandbox" \
  && ok "拡張がサンドボックス指定されている" || ng "app-sandbox entitlement が無い（FCP に出ない原因No.1）"

# 5. 署名が壊れていないか
codesign --verify --strict "$APPEX" 2>/dev/null && ok "拡張の署名が有効" || ng "拡張の署名が壊れている"
codesign --verify --strict "$APP"   2>/dev/null && ok "アプリの署名が有効" || ng "アプリの署名が壊れている"

# 6. 何に依存しているか（Homebrew 事件の教訓：動くかではなく何に繋がっているか）
echo "--- 依存ライブラリ ---"
BAD=$(otool -L "$APPEX/Contents/MacOS/WorkflowExtension" | tail -n +2 | awk '{print $1}' \
      | grep -v '^/usr/lib/' | grep -v '^/System/' | grep -v '^@rpath/' || true)
if [ -n "$BAD" ]; then
  ng "システム外のライブラリに依存している:"; echo "$BAD"
else
  ok "システムライブラリのみに依存"
fi

echo
[ "$FAIL" -eq 0 ] && echo "🎉 関門すべて通過" || { echo "🚫 関門で不合格"; exit 1; }
