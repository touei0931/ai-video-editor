#!/bin/bash
#
# パネルが「読み込み中…」から進まないときに、原因を集める。
#
# 🔴 Final Cut を開いて、パネルを出した**あと**に走らせること。
#    インストール直後に走らせても、肝心の瞬間のログが入らない。
#    最初の診断はそれで空になり、原因に辿り着けなかった。
#
# 🔴 集めるだけ。何も直さないし、何も消さない。

OUT="$HOME/Desktop/PAC診断2.txt"
APP="/Applications/PAC for Final Cut.app"
APPEX="$APP/Contents/PlugIns/WorkflowExtension.appex"
BIN="$APPEX/Contents/MacOS/WorkflowExtension"

exec > >(tee "$OUT") 2>&1

echo "==================================="
echo " PAC パネルが出ないとき の診断"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "==================================="
echo
echo "  ※ Final Cut を開いて、ウィンドウ→エクステンション→PAC を"
echo "     押した**あと**に走らせてください。"
echo "     まだなら、いま押してから Enter を押してください。"
read -p "  準備できたら Enter: " _
echo

echo "--- 0. 拡張を直に動かしてみる（ここに答えが出ます） ---"
# 🔴 これが一番はっきりする。
#    足りないものがあれば dyld がその名前をそのまま言う。
#    パネル越しだと FCP が飲み込んでしまい、「読み込み中…」としか見えない。
"$BIN" 2>&1 | head -20
echo "(終了コード: $?)"
echo

echo "--- この版は直っているか（Final Cut の中を探しに行くか） ---"
# 🔴 otool を使わないこと。開発ツールが入っていない Mac では動かず、
#    「探しに行く先」が空欄になって**版の見分けが付かなかった**。
#    探し先は実行ファイルの中に文字としてそのまま入っているので、grep で読める。
if grep -qa "Final Cut Pro.app/Contents/Frameworks" "$BIN" 2>/dev/null; then
  echo "  OK: 直った版が入っています"
else
  echo "  NG: 古い版です。新しい zip を入れ直してください"
  echo "      （この版では拡張が起動できず、パネルは「読み込み中…」のまま止まります）"
fi
echo
echo "--- 0b. ProExtensionHost はどこにあるか ---"
# 🔴 「Final Cut の中にあるはず」で直したが、実在を確かめていなかった。
#    無ければ、探し先を足しても何も変わらない。
find /Applications/Final\ Cut\ Pro.app /Library/Frameworks /System/Library      /Library/Application\ Support -maxdepth 6 -name 'ProExtensionHost.framework' 2>/dev/null | head -5
echo "(1つも出なければ、この Mac のどこにも無いということです)"
echo

echo "--- 1. 拡張のプロセスは起きているか（ここが本命） ---"
pgrep -fl "WorkflowExtension" || echo "(起きていません ← 起動に失敗しています)"
echo

echo "--- 2. 落ちた記録 ---"
ls -lt "$HOME/Library/Logs/DiagnosticReports/"*.ips 2>/dev/null | head -10 || echo "(なし)"
NEWEST=$(ls -t "$HOME/Library/Logs/DiagnosticReports/"*WorkflowExtension*.ips 2>/dev/null | head -1)
if [ -n "$NEWEST" ]; then
  echo
  echo "  ▼ いちばん新しいもの: $(basename "$NEWEST")"
  head -60 "$NEWEST"
fi
echo

echo "--- 3. 直近20分のログ（絞り込まずに出す） ---"
# 🔴 grep で絞らないこと。前の診断は絞った結果ぜんぶ落ちて「(なし)」になった。
log show --last 20m --style compact \
  --predicate 'eventMessage CONTAINS "WorkflowExtension" OR eventMessage CONTAINS "com.touei.pac" OR eventMessage CONTAINS "PAC for Final Cut"' \
  2>&1 | tail -80
echo

echo "--- 4. 弾かれていないか（起動を止める側のログ） ---"
log show --last 20m --style compact \
  --predicate 'process == "amfid" OR process == "taskgated" OR process == "kernel" OR process == "pkd" OR process == "secinitd"' \
  2>&1 | grep -i -E "pac|workflow|deny|reject|invalid|kill" | tail -40
echo "(何も出なければ、止められてはいません)"
echo

echo "--- 5. 何に頼っているか（足りないと起動できない） ---"
otool -L "$BIN" 2>&1
echo
echo "--- この版は直っているか（Final Cut の中を探しに行くか） ---"
# 🔴 otool を使わないこと。開発ツールが入っていない Mac では動かず、
#    「探しに行く先」が空欄になって**版の見分けが付かなかった**。
#    探し先は実行ファイルの中に文字としてそのまま入っているので、grep で読める。
if grep -qa "Final Cut Pro.app/Contents/Frameworks" "$BIN" 2>/dev/null; then
  echo "  OK: 直った版が入っています"
else
  echo "  NG: 古い版です。新しい zip を入れ直してください"
  echo "      （この版では拡張が起動できず、パネルは「読み込み中…」のまま止まります）"
fi
echo

echo "--- 6. 中身が揃っているか ---"
echo "主クラス:"
plutil -extract NSExtension.ProExtensionPrincipalViewControllerClass raw "$APPEX/Contents/Info.plist" 2>&1
echo "画面のファイル:"
ls "$APPEX/Contents/Resources/webui/" 2>&1 | head -10
echo "解析エンジン:"
ls "$APP/Contents/Resources/engine/" 2>&1 | head -5
echo

echo "--- 7. 署名と権限 ---"
codesign -dv --entitlements :- "$APPEX" 2>&1 | head -40
echo
echo "拡張そのものの判定:"
spctl -a -vvv -t exec "$APPEX" 2>&1
echo

echo "--- 8. 環境 ---"
sw_vers
mdls -name kMDItemVersion /Applications/Final\ Cut\ Pro.app 2>/dev/null

echo
echo "==================================="
echo " 終わりました。"
echo
echo " デスクトップの「PAC診断2.txt」を touei に送ってください。"
echo "==================================="
read -p "Enter キーで閉じます"
