#!/bin/bash
# PAC for Final Cut.app を実際に起動し、パネルが使うのと同じ経路（127.0.0.1 のソケット）で
# 解析が通るかを確かめる。
#
# パネル(.appex) → ソケット → アプリ → エンジン、のうち
# 「ソケット → アプリ → エンジン」までをここで見る。
# 残る「パネル → ソケット」はサンドボックスの中なので、友達の Mac でしか確かめられない。
set -euo pipefail

APP="${1:?PAC for Final Cut.app のパスを渡してください}"
PORT=47829
WORK="$(mktemp -d)"

# 🔴 後始末で終了コードを握りつぶさないこと。
#    macOS の bash 3.2 は、EXIT トラップの最後のコマンドが成功すると
#    それを終了コードにしてしまう。関門が黙って通る一番まずい壊れ方になる。
cleanup() {
  code=$?
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" >/dev/null 2>&1 || true
  pkill -f "PAC for Final Cut.app/Contents/MacOS/PAC for Final Cut" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

echo "--- 検証用の日本語音声を作る ---"
say -v Kyoko -o "$WORK/voice.aiff" "サーバー経由の確認です。えー、これで通るはずです。"

echo "--- アプリを起動 ---"
# open -a だと出力が見えないので、実行ファイルを直に起動して記録する
"$APP/Contents/MacOS/PAC for Final Cut" > "$WORK/app.log" 2>&1 &
APP_PID=$!
echo "起動した pid=$APP_PID"

echo "--- 待ち受けが始まるのを待つ ---"
for i in $(seq 1 30); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/ping" | grep -q '"ok"'; then
    echo "✅ 待ち受けに繋がった: ${i} 秒"
    READY=1
    break
  fi
  sleep 1
done
if [ "${READY:-0}" != "1" ]; then
  echo "❌ 待ち受けに繋がらない（アプリ側のサーバーが上がっていない）"
  echo "--- アプリの出力 ---"
  cat "$WORK/app.log" || true
  echo "--- 生きているか ---"
  ps -p "$APP_PID" > /dev/null 2>&1 && echo "プロセスは生きている" || echo "プロセスが落ちている"
  echo "--- ポートの状態 ---"
  lsof -nP -iTCP:$PORT || echo "誰も掴んでいない"
  exit 1
fi

echo "--- 解析を頼む ---"
JOB=$(curl -s --max-time 10 -X POST "http://127.0.0.1:$PORT/analyze" \
  -H 'Content-Type: application/json' \
  -d "{\"videoPath\":\"$WORK/voice.aiff\",\"model\":\"base\",\"language\":\"ja\",\"cutPreset\":\"tight\",\"detectAside\":false}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('jobId',''))")

if [ -z "$JOB" ]; then
  echo "❌ 解析を受け付けてもらえなかった"
  curl -s -X POST "http://127.0.0.1:$PORT/analyze" -H 'Content-Type: application/json' \
    -d "{\"videoPath\":\"$WORK/voice.aiff\",\"model\":\"base\"}"
  exit 1
fi
echo "✅ 受け付けた: ${JOB}"

echo "--- 進み具合を追う ---"
# 🔴 パイプとヒアドキュメントで stdin を取り合わせないこと。
#    echo ... | python3 - <<'PY' は、ヒアドキュメントが stdin を奪うので
#    パイプ側が Broken pipe になる。受け渡しはファイルで行う。
for i in $(seq 1 180); do
  curl -s --max-time 5 "http://127.0.0.1:$PORT/progress?job=$JOB" -o "$WORK/prog.json" || true
  python3 - "$WORK/prog.json" "$WORK/done.json" <<'PYEOF'
import json, sys, os

try:
    p = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(0)

print(f"  {p.get('stage','?')} {round(float(p.get('ratio',0))*100)}%")
if p.get("error"):
    print("  エラー: " + p["error"])
if p.get("done"):
    json.dump(p, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
PYEOF
  if [ -f "$WORK/done.json" ]; then break; fi
  sleep 2
done

test -f "$WORK/done.json" || { echo "❌ 終わらなかった"; exit 1; }

python3 - "$WORK/done.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
if p.get("error"):
    print("❌ " + p["error"]); sys.exit(1)
r = p.get("result") or {}
assert r.get("telops"), "テロップが空（アプリ経由で推論が動いていない）"
print("✅ サーバー経由で解析できた")

# 🔴 設定がエンジンまで届いているか。
#    画面 → 拡張 → アプリ → エンジン と4つ跨ぐので、どこか1つ落ちると
#    黙って既定で解析される。エラーにならないので「候補が少ない」としか
#    見えない。実際に落ちていた（2026-08-31）。
report = r.get("report") or {}
used = report.get("cutPreset")
if used != "tight":
    print("❌ 詰め具合が届いていない（頼んだ: tight / 使われた: " + str(used) + "）")
    print("   アプリ（EngineServer）が --cut-preset を渡していない可能性があります")
    sys.exit(1)
print("✅ 詰め具合が届いた: tight")

if report.get("detectAside") is not False:
    print("❌ 独り言の入切が届いていない（使われた: " + str(report.get("detectAside")) + "）")
    sys.exit(1)
print("✅ 独り言の入切が届いた: 切")
for t in r["telops"]:
    print(f"   {t['start']:5.2f}s  {t['text']}")
PY

echo "🎉 パネルが使う経路で解析が通った"
