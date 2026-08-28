#!/bin/bash
# 配布前の関門。「ビルドが通った」ではなく「拡張として成立しているか」を見る。
# PAC で2度踏んだ「CI は通るのに友達の Mac で動かない」の再発防止。
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-build/Build/Products/Release/PAC for Final Cut.app}"
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

# 3b. UI が二重に入っていないか（Resources 直下にも同じ物が並ぶと、
#     どちらが使われているか分からなくなる）
if [ -f "$APPEX/Contents/Resources/index.html" ]; then
  ng "UI が Resources 直下にも入っている（二重同梱）"
else
  ok "UI の同梱は1か所だけ"
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

# 🔴 @rpath は素通しにしないこと。
#    ここは「ビルドした所では解決できる」だけで、相手の Mac で解決できるかは別。
#    CI では拡張を一度も起動しないので、解決できなくても緑のまま通る。
#    実際、友達の Mac で拡張が起動せず、パネルが「読み込み中…」から
#    進まなかった（2026-08-28）。どこを探しに行くのかを必ず目に見えるようにする。
echo "--- @rpath で探すもの（相手の Mac に無ければ起動できない） ---"
otool -L "$APPEX/Contents/MacOS/WorkflowExtension" | tail -n +2 | awk '{print $1}'   | grep '^@rpath/' || echo "(なし)"
echo "--- どこを探しに行くか（LC_RPATH） ---"
# 🔴 後方参照（バックスラッシュ+1）を使わないこと。この行を Python の
#    ヒアドキュメント越しに書くと制御文字に化け、パスの代わりに ^A が並ぶ。
#    余計なものを削るだけなら、置換2回で足りる（記号を書かずに済む）。
otool -l "$APPEX/Contents/MacOS/WorkflowExtension" | grep -A2 'LC_RPATH' | grep 'path ' | sed -e 's/ (offset [0-9]*)$//' -e 's/^ *path //'

# 🔴 @rpath で要るものが、実際に見つかる場所を探しに行くか。
#
#    ProExtensionHost.framework の本体は Final Cut Pro 自身の中にある。
#    こちらには同梱できない（Apple の SDK は再配布不可）ので、
#    FCP の中を探すよう伝えていないと、**どの Mac でも起動前に落ちる**。
#
#    ビルド・署名・PluginKit への登録はどれも通ってしまい、
#    CI は拡張を一度も起動しないので全部緑のまま出荷される。
#    実機で「読み込み中…」から進まない形でしか現れない（2026-08-28に踏んだ）。
#
# 🔴 otool の出力を切り分けないこと。
#    「Final Cut Pro.app」には空白が入る。$2 で取ると
#    "/Applications/Final" までしか取れず、**正しく入っているのに
#    嘘の不合格**が出る（b82e918 でも同じ罠を踏んでいる）。
#    まるごと1行として探せば、区切り方を間違えようがない。
FCP_RPATH="/Applications/Final Cut Pro.app/Contents/Frameworks"
if otool -L "$APPEX/Contents/MacOS/WorkflowExtension" | grep -q 'ProExtensionHost'; then
  if otool -l "$APPEX/Contents/MacOS/WorkflowExtension" | grep -qF "path $FCP_RPATH "; then
    ok "ProExtensionHost を Final Cut の中に探しに行く"
  else
    ng "ProExtensionHost を要求しているのに、Final Cut の中を探しに行かない（起動できません）"
  fi
fi

# 7. 解析エンジンと ffmpeg（同梱している場合）
ENGINE="$APP/Contents/Resources/engine/pac-engine/pac-engine"
FFMPEG_BIN="$APP/Contents/Resources/ffmpeg/ffmpeg"
if [ -e "$ENGINE" ] || [ -e "$FFMPEG_BIN" ]; then
  echo "--- 解析エンジン ---"
  [ -x "$ENGINE" ] && ok "エンジンが入っていて実行できる" || ng "エンジンが無い/実行できない: $ENGINE"
  [ -x "$FFMPEG_BIN" ] && ok "ffmpeg が入っていて実行できる" || ng "ffmpeg が無い/実行できない"

  # 「動くか」ではなく「何に依存しているか」を見る。
  # Homebrew のライブラリに繋がっていると、Homebrew の無い Mac では起動すらしない。
  for bin in "$ENGINE" "$FFMPEG_BIN"; do
    [ -f "$bin" ] || continue
    OUTSIDE=$(otool -L "$bin" 2>/dev/null | tail -n +2 | awk '{print $1}' | grep -v "^/usr/lib/" | grep -v "^/System/" | grep -v "^@" || true)
    if [ -n "$OUTSIDE" ]; then
      ng "$(basename "$bin") がシステム外に依存している:"; echo "$OUTSIDE"
    else
      ok "$(basename "$bin") はシステムライブラリのみに依存"
    fi
  done

  # 署名されていない Mach-O が残っていないか（残ると解析だけ動かない形で壊れる）
  UNSIGNED=0
  CHECKED=0
  # 🔴 $(find ...) をそのまま for に流さないこと。
  #    アプリ名に空白が入った途端、1つのパスが4語に割れて
  #    **1つも実在しないファイル**を検査することになる。
  #    それでも数は数えるので「240 個が未署名」のような、
  #    もっともらしい嘘の失敗が出る（2026-08-27 に踏んだ）。
  while IFS= read -r -d '' f; do
    [ "$CHECKED" -ge 60 ] && break
    CHECKED=$((CHECKED+1))
    codesign -v "$f" >/dev/null 2>&1 || UNSIGNED=$((UNSIGNED+1))
  done < <(find "$APP/Contents/Resources/engine" -type f \( -name "*.dylib" -o -name "*.so" \) -print0 2>/dev/null)
  [ "$UNSIGNED" -eq 0 ] && ok "同梱ライブラリの署名が通っている（$CHECKED 個を抜き取り検査）" || ng "署名されていないライブラリが $UNSIGNED 個ある"
fi

# 6. 器のアプリが「開かせない裏方」になっているか
#    🔴 ここが崩れると、手順書の「アプリを開いてください」が復活する。
#       友達はデスクトップ版 PAC と間違えて別のアプリを開き、話が食い違った。
APLIST="$APP/Contents/Info.plist"
NAME=$(basename "$APP")
[ "$NAME" != "PAC.app" ]   && ok "デスクトップ版と別の名前: $NAME"   || ng "デスクトップ版 PAC.app と同じ名前。入れ直すと片方が消える"

AGENT=$(/usr/libexec/PlistBuddy -c "Print :LSUIElement" "$APLIST" 2>/dev/null || echo "")
[ "$AGENT" = "true" ]   && ok "Dock に出さない設定になっている"   || ng "LSUIElement が立っていない（開かれる前提に戻っている）"

SCHEME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$APLIST" 2>/dev/null || echo "")
[ "$SCHEME" = "pac-fcp" ]   && ok "パネルから起こせる（$SCHEME://）"   || ng "URL スキームが無い。パネルがアプリを起こせない"

echo
[ "$FAIL" -eq 0 ] && echo "🎉 関門すべて通過" || { echo "🚫 関門で不合格"; exit 1; }
