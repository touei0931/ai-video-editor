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
if [ ! -d "PAC.app" ] && [ -f "PAC-fcp-test.zip" ]; then
  echo "▶ 展開中..."
  ditto -x -k "PAC-fcp-test.zip" .
fi

if [ ! -d "PAC.app" ]; then
  echo "❌ PAC.app が見つかりません。zip と同じフォルダに置いて実行してください。"
  echo "   （このファイルがある場所: $(pwd)）"
  read -p "Enter キーで閉じます"
  exit 1
fi

# 2) 検疫属性を外す（未署名アプリを開けるようにする）
echo "▶ ダウンロード検疫を解除..."
xattr -dr com.apple.quarantine "PAC.app" 2>/dev/null
xattr -cr "PAC.app" 2>/dev/null

# 3) /Applications へ設置（PluginKit は /Applications の中を見る）
echo "▶ アプリケーションフォルダへ設置..."
rm -rf "/Applications/PAC.app" 2>/dev/null
cp -R "PAC.app" "/Applications/" || {
  echo "❌ 設置に失敗しました。管理者パスワードが必要かもしれません。"
  read -p "Enter キーで閉じます"; exit 1
}
xattr -dr com.apple.quarantine "/Applications/PAC.app" 2>/dev/null

# 4) 一度起動して macOS に拡張を登録させる
echo "▶ 起動して登録..."
open "/Applications/PAC.app"
sleep 4

echo
echo "===== ここから下は開発者(touei)向けの情報です ====="
echo
echo "--- macOS / ハード ---"
sw_vers
uname -m
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
codesign -dvvv "/Applications/PAC.app/Contents/PlugIns/WorkflowExtension.appex" 2>&1 | head -20
echo
echo "--- 拒否されていないか (Gatekeeper) ---"
spctl -a -vvv -t exec "/Applications/PAC.app" 2>&1
echo
echo "--- 直近のエラーログ ---"
log show --last 3m --predicate 'process == "pkd" OR process == "Final Cut Pro" OR eventMessage CONTAINS "WorkflowExtension"' --style compact 2>/dev/null | grep -i -E "pac|workflowextension|sandbox|reject" | head -30 || echo "(なし)"

echo
echo "==================================="
echo " 終わりました。"
echo
echo " 次にやってほしいこと:"
echo "  1. Final Cut Pro を起動"
echo "  2. 上のメニュー「ウィンドウ」→「エクステンション」を開く"
echo "  3. 「PAC」があるか見る（あれば押して、出てきた画面を撮影）"
echo "  4. デスクトップの「PAC診断結果.txt」を touei に送る"
echo ""
echo " ※「テロップ作成開始」を押しても、まだ解析は動きません（想定どおりです）"
echo "==================================="
read -p "Enter キーで閉じます"
