#!/bin/bash
# PAC（Final Cut Pro プラグイン・動作テスト版）のインストーラ兼診断ツール。
# 友達がダブルクリックするだけで、設置 → 検疫解除 → 登録確認 → 報告ファイル作成まで行う。

cd "$(dirname "$0")"
REPORT="$HOME/Desktop/PAC診断結果.txt"
exec > >(tee "$REPORT") 2>&1

echo "==================================="
echo " PAC インストールと動作確認"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "==================================="
echo

# 1) zip を展開
if [ ! -d "PAC for Final Cut.app" ] && [ -f "PAC-fcp-test.zip" ]; then
  echo "▶ 展開中..."
  ditto -x -k "PAC-fcp-test.zip" .
fi

if [ ! -d "PAC for Final Cut.app" ]; then
  echo "❌ PAC for Final Cut.app が見つかりません。zip と同じフォルダに置いて実行してください。"
  echo "   （このファイルがある場所: $(pwd)）"
  read -p "Enter キーで閉じます"
  exit 1
fi

# 2) 検疫属性を外す（未署名アプリを開けるようにする）
echo "▶ ダウンロード検疫を解除..."
xattr -dr com.apple.quarantine "PAC for Final Cut.app" 2>/dev/null
xattr -cr "PAC for Final Cut.app" 2>/dev/null

# 3) /Applications へ設置（PluginKit は /Applications の中を見る）
echo "▶ アプリケーションフォルダへ設置..."
rm -rf "/Applications/PAC for Final Cut.app" 2>/dev/null
cp -R "PAC for Final Cut.app" "/Applications/" || {
  echo "❌ 設置に失敗しました。管理者パスワードが必要かもしれません。"
  read -p "Enter キーで閉じます"; exit 1
}
xattr -dr com.apple.quarantine "/Applications/PAC for Final Cut.app" 2>/dev/null

# 4) 一度起動して macOS に拡張を登録させる
#    🔴 画面には何も出ない（Dock にも出ない）。これで正常。
#       解析を回すだけの裏方で、普段はパネルが必要な時に自分で起こす。
echo "▶ 起動して登録..."
open "/Applications/PAC for Final Cut.app" 2>&1
sleep 5

# 本当に起動したか。ここで落ちていると、拡張も登録されない
if pgrep -f "PAC for Final Cut.app/Contents/MacOS/PAC for Final Cut" > /dev/null; then
  echo "  ✅ 起動しました（画面には何も出ません。これで正しいです）"
else
  echo "  ⚠️ 起動していません"
  echo "     システム設定 →「プライバシーとセキュリティ」を開き、"
  echo "     下のほうにある「このまま開く」を押してから、もう一度お試しください。"
fi

# デスクトップ版 PAC には触っていないことを、その場で見せる
if [ -d "/Applications/PAC.app" ]; then
  echo "  ℹ️ デスクトップ版の PAC.app はそのままです（別物なので消していません）"
fi

echo
echo "===== ここから下は開発者(touei)向けの情報です ====="
echo
echo "--- macOS / ハード ---"
sw_vers
uname -m
echo "Gatekeeper: $(spctl --status 2>&1)"
echo
echo "--- Final Cut Pro ---"
mdls -name kMDItemVersion "/Applications/Final Cut Pro.app" 2>/dev/null || echo "FCP が /Applications にありません"
echo
echo "--- 拡張が登録されたか (ここが本命) ---"
pluginkit -mAvvv -p com.apple.FinalCut.WorkflowExtension 2>&1
echo
echo "--- PAC の拡張だけ抜き出し ---"
pluginkit -mAvvv -p com.apple.FinalCut.WorkflowExtension 2>&1 | grep -i "pac" || echo "(PAC は登録されていません)"
echo
echo "--- 署名の状態 ---"
codesign -dvvv "/Applications/PAC for Final Cut.app/Contents/PlugIns/WorkflowExtension.appex" 2>&1 | head -20
echo
BIN="/Applications/PAC for Final Cut.app/Contents/PlugIns/WorkflowExtension.appex/Contents/MacOS/WorkflowExtension"
echo "--- 入っている版（画面の右上にも同じものが出ます） ---"
# 🔴 どの版が入っているかを記録に残すこと。
#    残していなかったので、直したものを渡しても
#    「本当にそれが入ったのか」を確かめられなかった。
WEBUI="/Applications/PAC for Final Cut.app/Contents/PlugIns/WorkflowExtension.appex/Contents/Resources/webui"
grep -hao '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9] [0-2][0-9]:[0-5][0-9]' "$WEBUI"/assets/*.js 2>/dev/null | head -1 || echo "(版が読めません。古い版です)"
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
echo "--- 拒否されていないか (Gatekeeper) ---"
spctl -a -vvv -t exec "/Applications/PAC for Final Cut.app" 2>&1
echo
echo "--- 直近のエラーログ ---"
log show --last 3m --predicate 'process == "pkd" OR process == "Final Cut Pro" OR eventMessage CONTAINS "WorkflowExtension"' --style compact 2>/dev/null | grep -i -E "pac|workflowextension|sandbox|reject" | head -30 || echo "(なし)"

echo
echo "==================================="
echo " 終わりました。"
echo
# 🔴 開いたままの Final Cut は、入れ替えても古い版を掴み続ける。
#    黙っていると「入れ直したのに直らない」を何度も繰り返すことになる（実際にそうなった）。
if pgrep -x "Final Cut Pro" >/dev/null 2>&1; then
  echo "  ⚠️  Final Cut Pro が開いたままです。"
  echo "     このままでは**古い版を掴んだまま**なので、必ず終了して開き直してください。"
  echo
fi

echo " 次にやってほしいこと:"
echo "  1. Final Cut Pro を**一度終了してから**起動し直す"
echo "     （開いたままだと、古い版を掴んだままになります）"
echo "  2. 上のメニュー「ウィンドウ」→「エクステンション」を開く"
echo "  3. 「PAC」があるか見る（あれば押して、出てきた画面を撮影）"
echo "  4. デスクトップの「PAC診断結果.txt」を touei に送る"
echo "     （見つからないときは、この画面の文字をコピーして送っても大丈夫です）"
echo ""
echo " ※ アプリを開く必要はありません。パネルが必要な時に自分で起こします"
echo " ※ 初回の解析だけ、文字起こしのモデル(約1.6GB)の取得で数分止まって見えます"
echo "==================================="
read -p "Enter キーで閉じます"
